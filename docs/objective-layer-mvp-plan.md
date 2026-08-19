# Objective Layer Implementation Plan

Branch: `local-stage-with-objective-layer`

Worktree:

```text
/Users/alenbohcelyan/Documents/AIProjects/openacme-platform-engineering/worktrees/local-stage-with-objective-layer
```

Last revised: 2026-08-11.

## Goal

Introduce objectives as a small layer above the existing task system.

The revised V1 principle is:

```text
Objective = task grouping + owner closeout wake.
```

An objective does not plan, verify, dispatch, decompose, or create sessions by itself. Its only active behavior is:

```text
When all linked tasks are terminal, wake the objective owner and ask:
"Can this objective be closed, or should another task be created/attached?"
```

The objective owner agent then decides whether to:

- mark the objective completed
- create or attach a follow-up task
- create or attach a verification task
- mark the objective failed or canceled

This keeps orchestration responsibility with agents and the existing task system.

The closeout wake should include a compact closeout briefing so the owner does
not have to re-read every task body/comment before making the first decision.
The briefing may include an AI-generated summary, but the system still does not
make the closeout decision.

## Non-Goals For V1

Do not implement these in V1:

- objective-created sessions
- objective supervisor sessions
- objective-driven fresh session creation
- automatic task decomposition
- automatic result interpretation
- automatic verification by a system service
- recurring objectives
- approval policies
- rescue/retry orchestration
- UI redesign

These may become later layers, but they are not needed for the first useful objective primitive.

AI-generated closeout summaries are allowed in V1 only as briefing assistance.
They must not become automatic verification or automatic closeout.

## Existing Architecture Findings

### Task Package

Core task domain types live in:

```text
packages/tasks/src/types.ts
packages/tasks/src/store.ts
packages/tasks/src/ports.ts
```

Current task statuses:

```text
open
in_progress
blocked
system_blocked
done
canceled
```

Important existing behavior:

- `TaskStore` is the public API boundary for task create/read/update/delete.
- Task state is SQL-backed when `TaskStoreOptions.db` is provided.
- Comments and events are external ports injected into `TaskStore`.
- `task_comment(mode: "result")` is the canonical final answer surface for a task.
- `task_update(status: "done")` soft-warns when a task is completed without a result comment.
- Dispatcher does not pre-mark work in progress; agents claim tasks themselves.
- Existing task/session semantics must remain intact.

### DB Package

Canonical DB schema lives in:

```text
packages/db/src/schema.ts
```

Migration pattern:

- Edit `packages/db/src/schema.ts`.
- Run `pnpm --filter @openacme/db db:generate`.
- Commit generated SQL and Drizzle metadata.
- Do not hand-write `ALTER TABLE` migrations.

`packages/db/test/clean-bootstrap.test.ts` verifies fresh schema shape and indexes.

### Server And Tools

AgentManager wiring:

```text
packages/server/src/agent-manager.ts
```

Task routes:

```text
packages/server/src/routes/tasks.ts
```

Task tools:

```text
packages/tools/src/builtins/tasks.ts
```

Prompt guidance:

```text
packages/agent-core/src/prompt.ts
```

Objective tooling should follow the existing bind/register pattern:

```text
bindObjectiveStore(...)
registry.register(...)
```

## Core Semantics

Separate the three concepts:

```text
Objective = goal record and closeout responsibility
Task      = executable work record
Session   = execution context
```

Objective does not imply a new session.
Objective does not imply a task.
Objective does not imply fresh dispatch.

Agents choose task/session strategy. Objective only records the grouping and creates the closeout wake when linked task work reaches a terminal state.

Agent decision rule:

- Do not create objectives for simple one-turn actions.
- If the agent will create multiple tasks for the same intended outcome, it
  must create one objective or reuse an existing objective only when it is the
  same logical grouping and original scope, then link every related task to it.
- Do not reopen or attach new work to a past objective merely because the title
  sounds related. If the work is a new phase, new scope, or new outcome, create
  a new objective.
- Only relink, cancel, or reopen prior work when the user is explicitly asking
  to continue, correct, or rectify that prior work.
- A multi-task outcome should not be left as loose unrelated tasks.

## Session Rules

V1 rules:

- Objective creation never creates a session.
- Task creation keeps today’s existing task/session behavior.
- A task may be linked to an objective with `objective_id`.
- A task linked to an objective may be same-session, fresh-session, delegated, scheduled, or manually driven.
- Objective closeout wake goes to the objective owner agent/session recorded at objective creation.

Therefore these are all valid:

```text
Objective O1
  tasks = []
  owner_session = current session
```

```text
Objective O1
  Task T1 objective_id = O1, session_id = current session
```

```text
Objective O1
  Task T1 objective_id = O1, session = fresh
  Task T2 objective_id = O1, session = fresh
```

The number of sessions is determined by task execution choices, not by the objective system.

## Session Context And Preflight Info

Objective state must be visible in the agent's normal session context, but only
as a small snapshot. This follows the current task prompt pattern: session
context helps orientation, while tools provide live state.

V1 rules:

- Add a bounded objectives snapshot to the system/session context when objective
  tools are available.
- The snapshot should include objectives relevant to the current agent/session:
  owned objectives, objectives created in the session, and objectives linked to
  tasks in the session.
- Include only compact fields:
  - id
  - title
  - status
  - owner_agent_id
  - owner_session_id
  - linked task counts
  - closeout state/fingerprint presence
  - short closeout prompt excerpt
- Do not include task bodies, comment bodies, closeout packets, or AI closeout
  briefs in the cached system prompt.
- The snapshot must state that it may be stale and that the agent should call
  `objective_view`, `objective_list`, `task_list`, and `task_comments` for live
  state before making closeout decisions.
- The snapshot must be bounded and counted by existing preflight token
  estimation because it is part of the system prompt/model context.

This is separate from the closeout wake payload. The closeout wake carries a
fresh deterministic packet/brief when all linked tasks are terminal; the session
context snapshot only orients the agent at session start/preflight time.

## Existing-Behavior Edge Decisions

These decisions intentionally stay close to current task/session behavior.

### Owner Session Target

Existing compaction behavior preserves the original session id:

```text
SessionStore.renameAndForkInTransaction(parentId)
  archives old messages under a fresh archived id
  re-inserts the active session at the original parentId
```

Therefore objective `owner_session_id` does not need active-leaf remapping for
normal preflight compression.

Closeout delivery target rules:

```text
if owner_session_id exists
and sessionStore.get(owner_session_id) exists
and session.agentId == owner_agent_id:
  deliver targeted inbox notice with relatedSession = owner_session_id
else:
  deliver agent-wide inbox notice with relatedSession = null
  append objective event owner_session_unavailable
```

Do not add a session-leaf resolver in V1 unless a focused test proves it is
needed. The existing compression path is already designed to keep external
session references stable.

### Session Delete

Current `/api/sessions/:id` behavior does not delete bound tasks. It clears
`session_id` for nonterminal tasks and resets `in_progress` tasks to `open` so
the dispatcher can pick them again. The dispatcher also has a legacy dangling
session binding recovery path.

V1 objective behavior should align with that:

- Do not change session delete semantics as part of objective V1.
- Do not delete objectives just because `owner_session_id` was deleted.
- If closeout later needs to wake a deleted owner session, use the agent-wide
  fallback described above.
- If tasks are rebound after session delete, they keep their `objective_id`.

### Agent Delete And Orphan Cleanup

Current agent deletion deletes tasks assigned to or created by the deleted
agent. Orphan purge deletes tasks whose assignee no longer exists.

Objective V1 should follow that pattern:

- Explicit agent delete should delete objectives where `owner_agent_id` is the
  deleted agent.
- Orphan purge should delete objectives whose `owner_agent_id` no longer exists.
- This is cleanup, not a new objective status. Do not add `system_blocked` for
  missing objective owners in V1.

### Task Delete And Detach

Current `TaskStore.delete` hard-deletes the task row and comments, emits a
`task_deleted` event, and leaves historical events as audit. Deletion is
cleanup, not a terminal task result.

Objective V1 should align with that:

- A deleted task no longer counts as linked or terminal.
- A detached task no longer counts as linked or terminal.
- If an objective has zero linked tasks, keep the existing no-task rule: the
  closeout watcher ignores it and the owner can manually close it or attach more
  tasks.
- Do not infer objective completion from task deletion/detach.

### Recurring Linked Tasks

Current recurring task behavior resets a completed recurrence back to `open`
with the next `start_at`; for `recurrence.session: "fresh"` it also clears
`session_id`.

Objective V1 should align with that:

- Recurring tasks may be linked to objectives, but they are usually a poor fit
  for finite objective completion.
- A recurring task does not make an objective ready for closeout on every run,
  because completion resets it back to nonterminal `open`.
- The objective becomes ready only when all linked tasks are terminal at the
  same check, for example after the recurring task is canceled or detached.

### Ready Objective Reopened By More Work

TaskStore should remain objective-agnostic. Objective-aware tools/routes own
objective status repair.

Rules:

- If `objective_attach_task` attaches a nonterminal task to a
  `ready_for_closeout` objective, set the objective back to `waiting_on_tasks`
  and append `objective_reopened`.
- If `task_create(..., objective_id)` creates a nonterminal task under a
  `ready_for_closeout` objective through objective-aware tooling, set it back to
  `waiting_on_tasks`.
- If a task is manually updated from terminal back to nonterminal, objective
  status repair can happen through the task tool/API layer when objective store
  is available; otherwise the next owner/tool action can repair it.
- Do not make `TaskStore` depend on `ObjectiveStore`.

### Prompt Snapshot Cache

Current task context in the system prompt is a cached session-start snapshot and
may be stale. Agents are already told to use read tools for live task state.

Objective V1 should align with that:

- Do not invalidate the system prompt cache on every objective mutation.
- Objective tool results and closeout wake payloads provide fresh per-turn
  information.
- New sessions or normal prompt rebuilds include the bounded objectives
  snapshot.
- If a future UX needs immediate prompt refresh, use the existing
  `Agent.invalidateSystemPromptCache` seam deliberately; do not make it the
  default mutation behavior.

### Closeout Delivery Idempotency

Existing task event to inbox fan-out is not a strict cross-store transaction;
it is best-effort with durable task/event state and retryable scheduling.
Objective closeout should use the same pragmatic pattern.

Rules:

- Compute a closeout fingerprint from linked task ids, statuses, and relevant
  close/update timestamps.
- Persist `ready_for_closeout`, `last_closeout_fingerprint`, closeout packet
  snapshot, and `linked_tasks_terminal` in objective storage.
- Deliver the owner inbox notice.
- Append `owner_wake_requested` with the fingerprint after successful inbox
  delivery.
- If inbox delivery fails before `owner_wake_requested`, the closeout service
  may retry delivery for `ready_for_closeout` objectives whose fingerprint has
  no matching `owner_wake_requested` event.
- Duplicate owner notices are less harmful than lost owner notices, but repeated
  identical notices must be bounded by fingerprint/event checks.

## Closeout Behavior

The only automatic objective behavior in V1:

```text
if objective.status in active/waiting_on_tasks
and objective has one or more linked tasks
and every linked task has terminal status
then:
  set objective.status = ready_for_closeout
  append objective event: linked_tasks_terminal
  build closeout packet
  optionally add bounded AI closeout brief
  deliver inbox notice to objective.owner_agent_id
    targeted to owner_session_id when valid
    otherwise agent-wide
```

Terminal task statuses:

```text
done
canceled
```

The closeout watcher does not decide whether canceled tasks are acceptable. It only wakes the owner. The owner agent reads results, checks whether canceled tasks matter, and either closes the objective or creates more work.

This is the key simplification:

```text
System detects "time to decide."
Owner agent performs the decision.
```

## Closeout Packet And AI Brief

The closeout wake should carry enough context for the owner agent to decide
without immediately loading every linked task and comment.

Required deterministic packet:

```text
objective:
  id
  title
  description
  closeout_prompt
  status

linked_tasks:
  - id
    title
    status
    assignee
    session_id
    updated_at
    closed_at
    latest_result_comment_excerpt
    latest_system_comment_excerpt
    latest_comment_excerpts
```

Optional bounded AI-generated closeout brief:

```text
closeout_brief:
  task_outcomes:
    - task_id
      claimed_result
      warnings
      unresolved_notes
      evidence_mentions
  objective_risks:
    - ...
  suggested_owner_action:
    close_completed | create_followup | create_verification | close_failed | close_canceled
  rationale
```

Closeout brief output is intentionally small because it is sent to the owner
agent that will be woken for closeout. The deterministic packet already
contains the task manifest and excerpts, so the AI output should be a triage
brief for the next decision, not a second copy of the work history.

Recommended V1 output shape limits:

```text
max_task_outcomes: 10
max_warnings: 8
max_unresolved_notes: 8
max_objective_risks: 5
max_evidence_mentions_per_task: 3
max_rationale_tokens: 180
```

If more tasks or warnings exist, the brief should aggregate them and include
counts/truncation flags instead of expanding the output. The owner agent should
drill down with `objective_view`, `task_view`, and `task_comments` when it needs
detail.

The AI brief is not authoritative. It is a compression aid for the owner
agent's next turn. The owner can still call `objective_view`, `task_view`, and
`task_comments` for full context.

Hard rule:

```text
Closeout wake must not depend on AI summary success.
```

If AI summarization fails, times out, or exceeds budget, the watcher must still
send the deterministic closeout packet and record that the AI brief was
unavailable.

Boundaries for summarization:

- Use bounded input: task frontmatter, task body excerpt, latest result comment,
  latest system comment, and recent comment excerpts.
- Prefer result comments over arbitrary discussion when trimming.
- Include canceled/system-blocked status prominently.
- Never include raw unbounded comment history.
- Never let summary generation block existing task dispatcher behavior.
- Summary output should be structured JSON or a small typed object, not freeform
  chat text.

### Summary Input Budget Policy

The summarizer must receive a packed, bounded input object. Its input budget
comes from the configured summary model's context window, not from a fixed
schema value. It must never be given all task bodies or all comments just
because an objective has many linked tasks.

Budget derivation:

```text
target_summary_output_tokens =
  min(configured_output_override
        ?? default_closeout_brief_output_tokens,
      model_max_output_tokens,
      service_output_safety_cap_tokens)

model_context_window_tokens
- system/developer prompt budget
- objective summarizer instruction budget
- target_summary_output_tokens
- safety headroom
= derived_summary_input_budget_tokens

max_summary_input_tokens =
  min(configured_input_override ?? derived_summary_input_budget_tokens,
      service_input_safety_cap_tokens)
```

`target_summary_output_tokens` is the value passed to the model call as
`max_output_tokens` or the provider equivalent. It is determined before input
packing because input budget must reserve room for the output.

The default output target is a product/service decision, not a model maximum.
For closeout V1, the brief should be short enough to fit naturally in the
owner's next turn context. Recommended starting point:

```text
default_closeout_brief_output_tokens: 600
service_output_safety_cap_tokens: 1_000
```

Use a configured override only to lower/raise this within the service cap. Do
not automatically expand output to the model maximum just because the model can
produce more tokens.

Token budget is the primary contract. Character limits are only a fallback when
the runtime does not have a tokenizer or model metadata available. A reasonable
fallback approximation is:

```text
max_summary_input_chars ~= max_summary_input_tokens * 4
```

Recommended V1 fallback/default configuration:

```text
default_closeout_brief_output_tokens: 600
service_output_safety_cap_tokens: 1_000
summary_safety_headroom_tokens: 4_000
service_input_safety_cap_tokens: 32_000
fallback_max_summary_input_chars: 32_000
fallback_max_summary_output_chars: 2_500
fallback_max_compression_input_chars: 24_000
max_comment_chunk_chars: 12_000
max_comment_chunk_overlap_chars: 500
max_comment_chunks_per_comment: 8
max_task_compression_output_chars: 2_500
max_full_detail_tasks: 20
per_task_body_excerpt_chars: 1_200
per_task_result_excerpt_chars: 2_500
per_task_system_excerpt_chars: 1_200
per_task_recent_comment_count: 3
per_task_recent_comment_excerpt_chars: 800
```

These are service/summarizer configuration values, not schema facts. Production
should derive token limits from the selected summary model. Tests should use
small fake model limits to prove truncation, compression, and skip behavior.

Packing order:

1. Objective id/title/status/description/closeout_prompt.
2. Linked task manifest for every task:
   - id
   - title
   - status
   - assignee
   - session_id
   - updated_at
   - closed_at
   - has_result_comment
   - comment_count
3. Full detail for highest-signal tasks until budget is exhausted:
   - canceled tasks
   - system_blocked tasks if present historically
   - done tasks without result comments
   - tasks with latest system warning/comment
   - tasks most recently closed
   - remaining tasks by stable id order
4. Per selected task, include result excerpt first, then system excerpt, then
   recent comment excerpts, then body excerpt if budget remains.

Single-pass first rule:

```text
if packed objective + selected task subjects/comments <= max_summary_input_budget:
  call the objective summarizer once
else:
  run bounded task/comment compression only for the oversized evidence needed
  repack objective summary input
  call the objective summarizer once with compressed evidence
```

The closeout service should not run task-level or chunk-level summarization
when the combined objective/task/comment input already fits the objective
summary budget. The common path is one model call for the closeout brief.

Large task/comment compression:

Before dropping high-value evidence, the closeout service may run a bounded
compression pre-pass outside `Dispatcher.tick()`.

Use this only after the combined packed objective/task/comment input exceeds
`max_summary_input_budget`, and only for selected high-signal tasks whose
result/system comment content is causing or materially contributing to the
budget overflow.

Compression flow:

```text
for each oversized selected task:
  if selected evidence for the task <= max_compression_input_chars:
    ask the summarizer for a task-scoped evidence summary
  else:
    split oversized comments into deterministic chunks
    summarize each chunk independently
    summarize the chunk summaries into one task-scoped evidence summary
  add the task evidence summary to the objective summary input
```

Chunking rules:

- Chunk by stable character ranges or token-aware ranges if the runtime already
  has a tokenizer available.
- Prefer semantic boundaries when cheap: paragraph, markdown heading, fenced
  block, then sentence.
- If semantic splitting cannot satisfy the limit, split by fixed-size ranges.
- Use small overlap so boundary context is not lost.
- Preserve source references in summaries:
  - task id
  - comment id
  - chunk index
  - original character range
- Cap chunks per comment. If a comment still exceeds the cap, summarize the
  first chunks and record `comment_chunk_budget_exceeded`.

The task-scoped evidence summary should answer:

```text
task_id
comment_sources
claimed_result
important_evidence
warnings
unresolved_notes
possible_mismatch_with_task_request
truncation_notes
```

This compression is a convenience, not a dependency. If task/comment
compression fails, times out, or exceeds cost/budget:

- record `closeout_brief_failed` or `closeout_brief_partial` with the task id
  and reason.
- keep deterministic excerpts and truncation flags.
- still deliver the owner closeout wake.

If the packed input still exceeds `max_summary_input_budget`, trim in this order:

1. Drop task body excerpts.
2. Replace oversized result/system comments with task-scoped evidence summaries
   when available.
3. Drop non-result recent comment excerpts.
4. Shorten system comment excerpts.
5. Shorten result excerpts.
6. Reduce full-detail tasks.
7. Keep only objective metadata plus the all-task manifest.

If even objective metadata plus the all-task manifest exceeds the limit:

- Do not call the AI summarizer.
- Store `closeout_brief_failed` with reason `input_budget_exceeded`.
- Deliver the deterministic closeout packet with a `summary_input_truncated`
  flag and manifest counts.
- The owner agent must use `objective_view`, `task_list`, and targeted
  `task_comments` calls to inspect details before closing.

For V1, do not add unbounded recursive summarization. Allow only the bounded
two-level compression described above:

```text
comment chunks -> task evidence summary -> objective closeout brief
```

Do not recursively summarize objective summaries again.

## Owner Agent Responsibilities

When awakened for closeout, the owner agent should:

1. Read the objective.
2. Read linked tasks.
3. Read relevant task result comments.
4. Compare task outcomes with the original objective.
5. Choose exactly one next action:
   - mark objective completed
   - create/attach follow-up task
   - create/attach verification task
   - mark objective failed
   - mark objective canceled

The owner can delegate verification by creating a verification task. When that task finishes, the closeout wake happens again and the owner makes the final call.

## Data Model

### Objective Statuses

Use objective-specific statuses:

```text
active
waiting_on_tasks
ready_for_closeout
completed
failed
canceled
```

No `verifying` status in V1. Verification is just a task or owner-agent behavior.

### Objectives Table

```text
objectives
  id text primary key
  title text not null
  description text not null default ''
  status text not null
  owner_agent_id text not null
  owner_session_id text null
  created_by text not null
  created_in_session_id text null
  closeout_prompt text not null default ''
  created_at text not null
  updated_at text not null
  completed_at text null
  completion_summary text null
  last_closeout_fingerprint text null
  last_closeout_brief_json text null
  last_closeout_brief_at text null
```

Notes:

- `created_by` is audit.
- `owner_agent_id` is closeout responsibility.
- `owner_session_id` is where closeout notices should point when known.
- `closeout_prompt` is optional owner guidance for final review.
- `last_closeout_fingerprint` prevents repeated identical closeout wake spam.
- `last_closeout_brief_json` caches the latest bounded closeout brief sent to
  the owner so the API/UI can show the same packet the agent saw.

### Task Link

Add nullable objective id to tasks:

```text
tasks.objective_id text null
```

### Objective Events

```text
objective_events
  id text primary key
  objective_id text not null references objectives(id) on delete cascade
  event_type text not null
  actor text not null
  summary text not null
  details_json text null
  created_at integer not null default unixepoch()
```

Useful V1 event types:

```text
objective_created
objective_updated
task_attached
task_detached
linked_tasks_terminal
owner_wake_requested
owner_session_unavailable
closeout_brief_generated
closeout_brief_failed
objective_completed
objective_failed
objective_canceled
objective_reopened
```

### Indexes

```text
idx_objectives_status(status)
idx_objectives_owner(owner_agent_id, status)
idx_objectives_owner_session(owner_session_id)
idx_objective_events_objective(objective_id, created_at)
idx_tasks_objective(objective_id)
```

## Store Ownership

Recommended package split:

- Put shared objective status/type constants in `@openacme/tasks` if tools/server need a stable public union.
- Put the concrete SQL-backed objective store in `@openacme/db`.

Reasoning:

- Objectives are SQL-only in V1.
- They do not need markdown import/backup compatibility.
- Existing concrete DB stores already live under `packages/db/src/stores`.
- This avoids expanding `@openacme/tasks` into another SQL-only aggregate.

## Objective Store API

Recommended first API:

```text
createObjective(input)
getObjective(id)
listObjectives(filter)
updateObjective(id, patch)
completeObjective(id, summary, actor)
failObjective(id, summary, actor)
cancelObjective(id, summary, actor)
appendObjectiveEvent(input)
listObjectiveEvents(id)
recordCloseoutBrief(id, brief, actor)
deleteObjectivesForOwner(agentId, actor)
```

Task attachment can be implemented through `TaskStore.update(taskId, { objective_id })`, with objective-specific route/tool helpers wrapping it for ergonomics and ledger events.

`deleteObjectivesForOwner` is an internal cleanup API for agent delete/orphan
purge. Do not expose it as an agent tool in V1.

## Closeout Watcher

Name the scanner narrowly:

```text
ObjectiveCloseoutWatcher
```

Do not call it `ObjectiveSupervisor` in V1. It does not supervise or verify work.

Responsibilities:

1. Find active/waiting objectives with linked tasks.
2. Check whether all linked tasks are terminal.
3. Fingerprint the linked terminal state.
4. Build a deterministic closeout packet.
5. Optionally generate a bounded AI closeout brief.
6. If the fingerprint is new:
   - set status `ready_for_closeout`
   - store the closeout packet/brief
   - append `linked_tasks_terminal`
   - deliver an inbox/system notice to the owner
   - append `owner_wake_requested`
7. Never create tasks.
8. Never mark completed/failed.
9. Never treat the AI brief as a decision.

The watcher must not run inside the existing task dispatcher tick in V1.
Task scheduling is the higher-priority critical path, so objective closeout
needs its own service lifecycle.

## Ticker Safety Design

The existing `Dispatcher` is the task ticker. It binds unbound tasks, reads
inbox state, computes agent capacity, orders sessions, and starts autonomous
turns. Objective closeout must not add slow reads, model calls, summary
generation, or extra per-agent work to that path.

V1 therefore uses a separate service:

```text
ObjectiveCloseoutService
  owns its own interval
  owns its own in-flight serialization
  runs bounded objective scans
  builds deterministic closeout packets
  optionally runs summary generation outside Dispatcher.tick()
  delivers owner inbox notice
  lightly kicks Dispatcher after delivery
```

Dispatcher interaction is limited to:

```text
after inboxStore.deliver(closeout_notice):
  dispatcher.kick("objective_closeout")
```

`kick()` only asks the existing dispatcher to notice newly queued inbox work.
If the kick fails or the dispatcher is not currently running, the owner notice
still remains in `agent_inbox` and the normal dispatcher interval can pick it
up later.

Hard safety rules:

- Do not add `ObjectiveCloseoutWatcher` to `DispatcherOptions`.
- Do not call objective scans from `Dispatcher.tick()`.
- Do not call an LLM from any dispatcher-owned call stack.
- Do not let closeout summary failure block inbox delivery.
- Do not let closeout service errors throw into dispatcher control flow.
- Keep objective checks idempotent with `last_closeout_fingerprint`.
- Put a per-check objective limit on the service, for example 25-50 objectives.
- Put a per-check wall-clock budget on the service, for example 25-100 ms before yielding to the next interval.
- Run AI summary generation with explicit timeout, bounded input, and low concurrency.
- Make crash recovery deterministic: if the process dies before notice delivery,
  the next service check can recompute the same fingerprint and deliver once.

Recommended lifecycle:

```text
server startup
  -> manager.dispatcher.start()
  -> manager.objectiveCloseoutService.start()

server shutdown
  -> manager.objectiveCloseoutService.stop()
  -> manager.objectiveCloseoutService.drain()
  -> manager.dispatcher.stop()
  -> manager.dispatcher.drain()
```

Stopping the closeout service before the dispatcher prevents new closeout
notices from being queued while the scheduler is already draining.

The service can expose `kick(reason)` for future task-event-triggered checks,
but V1 can rely on its own interval. A future event hook may call
`objectiveCloseoutService.kick("task_event")` after task terminal updates;
that hook must still only enqueue a bounded service pass, never run the scan
inside the event emitter or dispatcher.

The summarization seam should be injectable so tests can use a deterministic
fake and production can use the configured model path later.

## Objective Closeout Telemetry

Because objective closeout runs as a separate background cycle, it must be
observable through OTel. Telemetry is for service health and debugging, not for
storing task/comment content.

Use the existing OpenAcme telemetry integration. Do not create a new telemetry
package, bootstrap path, exporter setup, or objective-specific observability
layer.

Existing seams to reuse:

```text
packages/config/src/telemetry-bootstrap.ts
packages/llm-provider/src/observability.ts
packages/tools/src/observation.ts
```

Implementation guidance:

- Process/bootstrap stays owned by `@openacme/config/telemetry-bootstrap`.
- Server-side objective closeout spans should use the existing
  `withOpenAcmeSpan` / sanitized attribute pattern from `@openacme/llm-provider`
  because `@openacme/server` already depends on that package.
- Tool instrumentation continues to use `packages/tools/src/observation.ts`;
  objective service code should not invent a parallel tool observation path.
- If the current OTel bootstrap does not export metrics in the target runtime,
  do not add a new metrics exporter as part of the objective slice. Keep the
  metric names below as the intended instruments for the existing OTel setup
  when metrics are available, and rely on spans/logs for V1 visibility.

Recommended spans:

```text
objective.closeout.check
objective.closeout.scan_objective
objective.closeout.build_packet
objective.closeout.compress_task_evidence
objective.closeout.summarize
objective.closeout.deliver_notice
```

Recommended metrics:

```text
objective_closeout_checks_total
objective_closeout_check_failures_total
objective_closeout_check_duration_ms
objective_closeout_objectives_scanned_total
objective_closeout_objectives_ready_total
objective_closeout_notices_delivered_total
objective_closeout_notice_failures_total
objective_closeout_summary_calls_total
objective_closeout_summary_failures_total
objective_closeout_summary_timeouts_total
objective_closeout_compression_calls_total
objective_closeout_compression_failures_total
objective_closeout_pending_objectives
```

Recommended bounded attributes:

```text
objective.status
objective.closeout.reason
objective.closeout.result
linked_task_count
terminal_task_count
nonterminal_task_count
summary.used
summary.input_truncated
summary.failure_reason
summary.compression_used
summary.chunk_budget_exceeded
notice.delivered
dispatcher.kicked
```

Use `objective.id` only on traces/log-correlated spans where high-cardinality
ids are acceptable. Do not put objective ids, task ids, session ids, raw titles,
task bodies, comments, result text, or summary text on metrics.

Failure visibility:

- Service-level failures increment OTel failure metrics and are logged.
- Objective-specific failures also append objective ledger events when possible.
- Summary/compression failures are recorded separately from notice delivery
  failures.
- Task dispatcher health must remain independently observable; objective
  closeout failures must not be reported as dispatcher tick failures.

## Agent Tool Surface

Add objective tools in:

```text
packages/tools/src/builtins/objectives.ts
```

V1 tools:

```text
objective_create
objective_view
objective_list
objective_update
objective_attach_task
objective_detach_task
objective_close
objective_event
```

`objective_close` should support:

```text
status: completed | failed | canceled
summary: string
```

Task tool additions:

```text
task_create(..., objective_id?)
task_update(..., objective_id?)
task_list(..., objective_id?)
```

Tool guidance:

```text
Use objectives for tracked outcomes. Objectives do not create sessions or tasks by themselves.
If you create multiple tasks for the same intended outcome, create one objective or reuse an existing objective only when it is the same logical grouping and original scope, then link every related task to it.
Do not reopen or attach new work to a past objective merely because the title sounds related; if the work is a new phase, new scope, or new outcome, create a new objective.
Only relink, cancel, or reopen prior work when the user is explicitly asking to continue, correct, or rectify that prior work.
Attach tasks when you create separate executable work for an objective.
When all linked tasks finish, the objective owner is woken to decide whether to close the objective or create more work.
Do not create objectives for simple one-turn actions.
```

## HTTP Routes

Recommended routes:

```text
GET    /api/objectives
POST   /api/objectives
GET    /api/objectives/:id
PATCH  /api/objectives/:id
GET    /api/objectives/:id/events
POST   /api/objectives/:id/tasks/:taskId
DELETE /api/objectives/:id/tasks/:taskId
POST   /api/objectives/:id/close
```

List/detail should include a task rollup:

```text
linked_task_count
terminal_task_count
nonterminal_task_count
```

Do not make API routes perform verification.

## Code-Grounded Runtime Flow

This section maps the V1 behavior onto the current codebase.

### Creating An Objective From A Normal Chat

Current chat/session creation remains unchanged. Creating an objective from a chat must not mutate `sessions.kind`.

Flow:

```text
agent turn in session S1
  -> objective_create tool
  -> ObjectiveStore.create({
       owner_agent_id: current agent id,
       owner_session_id: current session id,
       created_by: current agent id,
       created_in_session_id: current session id
     })
  -> session S1 remains kind = chat
```

The objective references the session; it does not classify the session.

### Linking Tasks To Objectives

Task execution stays in `TaskStore`.

Flow:

```text
task_create({ ..., objective_id: O1 })
  -> TaskStore.create stores tasks.objective_id = O1
  -> existing session/default/fresh/delegation rules apply unchanged
```

For existing tasks:

```text
objective_attach_task(O1, T1)
  -> validate objective exists
  -> validate task exists
  -> TaskStore.update(T1, { objective_id: O1 })
  -> if objective.status == ready_for_closeout and task is nonterminal:
       ObjectiveStore.update(O1, { status: waiting_on_tasks })
       ObjectiveStore.appendEvent(objective_reopened)
  -> ObjectiveStore.appendEvent(task_attached)
```

Detaching is the same shape with `objective_id: null` plus `task_detached`.

### Closeout Wake

The closeout watcher observes only terminality, not quality.

Flow:

```text
ObjectiveCloseoutService interval/kick
  -> serialize with closeoutCheckInFlight/closeoutCheckAgain
  -> ObjectiveCloseoutWatcher.check({ limit, budgetMs })
       load a bounded batch of active/waiting objectives
       load linked tasks with taskStore.list({ objective_id })
       if linked_task_count > 0 and all linked tasks are done/canceled:
         compute fingerprint from linked task ids + statuses + closed_at/updated_at
         if fingerprint != objective.last_closeout_fingerprint
         or owner_wake_requested is missing for fingerprint:
           build deterministic closeout packet from tasks/comments/results
           try build bounded AI closeout brief outside Dispatcher.tick()
           if AI brief fails, keep deterministic packet and record failure
           set objective.status = ready_for_closeout
           save fingerprint
           save closeout packet/brief snapshot
           append linked_tasks_terminal
           resolve owner delivery target:
             if owner_session_id exists and session exists and belongs to owner_agent_id:
               relatedSession = owner_session_id
             else:
               relatedSession = null
               append owner_session_unavailable
           inboxStore.deliver({
             agentId: objective.owner_agent_id,
             kind: "system_notice",
             source: "system",
             sourceId: "system:objective-closeout",
             relatedSession,
             payload: {
               eventKind: "objective_ready_for_closeout",
               objectiveId,
               linkedTaskIds,
               closeoutPacket,
               closeoutBrief,
               prompt
             }
           })
           append owner_wake_requested with fingerprint
           dispatcher.kick("objective_closeout")
```

The dispatcher is only kicked after an inbox row exists. Objective closeout does
not participate in dispatcher capacity calculation, session ordering, task
binding, or turn spawning.

Owner wake compatibility requirement:

- Closeout notices must use `kind: "system_notice"`,
  `sourceId: "system:objective-closeout"`, and `relatedSession:
owner_session_id` when an owner session is known.
- The existing dispatcher targeted-inbox path should wake that owner session
  even when it is a normal taskless chat session.
- Add a regression test that starts the dispatcher, delivers an objective
  closeout notice to a chat session, and proves one autonomous owner turn is
  spawned.
- If that regression fails, fix only the narrow objective-closeout inbox
  routing rule; do not make arbitrary background system notices wake every
  taskless chat session.

The watcher must not:

- create tasks
- close objectives
- call an LLM
- modify `sessions.kind`
- alter task dispatcher decisions

Exception: a bounded AI closeout brief may be generated through an injected
summarizer seam. That summarizer is allowed to call a model, but its failure
must never prevent owner wake delivery.

### Owner Closeout

The owner agent receives the system notice in the existing inbox drain path.

Then the owner agent decides:

```text
objective_view(O1)
task_list({ objective_id: O1 })
task_comments(Tn, { kinds: ["result"] })

if satisfied:
  objective_close({ id: O1, status: "completed", summary })
else if more work needed:
  task_create({ ..., objective_id: O1 })
else if separate verification needed:
  task_create({ title: "Verify ...", objective_id: O1, ... })
else:
  objective_close({ id: O1, status: "failed" | "canceled", summary })
```

If the owner creates another linked task, the objective should leave `ready_for_closeout` and return to `waiting_on_tasks` or `active`.

## Concrete Touch Map

### `@openacme/db`

Files:

```text
packages/db/src/schema.ts
packages/db/src/index.ts
packages/db/src/stores/objective-store.ts
packages/db/test/clean-bootstrap.test.ts
packages/db/test/objective-store.test.ts
packages/db/drizzle/*
```

Work:

- Add `objectives` table.
- Add `objective_events` table.
- Add `tasks.objective_id`.
- Add indexes listed in the data model section.
- Export objective tables and store types.
- Implement SQL store using the same Drizzle pattern as `comment-store.ts`.
- Generate migration with `pnpm --filter @openacme/db db:generate`.

Important constraints:

- Do not add `objective` to `sessions.kind`.
- Do not add FK constraints to agents; agent ids are filesystem labels today.
- Keep `tasks.objective_id` as a nullable non-FK link in V1 so `TaskStore`
  remains objective-agnostic and task delete/detach stays cleanup-oriented.
- `objective_events.objective_id` is the FK/cascade-owned ledger relationship.

### `@openacme/tasks`

Files:

```text
packages/tasks/src/types.ts
packages/tasks/src/store.ts
packages/tasks/src/index.ts
packages/tasks/test/sql-store.test.ts
packages/tasks/test/store.test.ts
```

Work:

- Add `objective_id: string | null` to task frontmatter/schema with default null.
- Add `objective_id` to `TaskCreate`, `TaskUpdate`, and `TaskListFilter`.
- Add SQL row mapping for `objective_id`.
- Add SQL insert/update/list filtering.
- Add file-backed serialization support so tests and legacy file paths preserve the field.

Important constraints:

- Do not make `TaskStore` know objective existence by default.
- Do not change task status transitions.
- Do not change session assignment/default/fresh behavior.
- Do not change dispatcher readiness rules.

### `@openacme/tools`

Files:

```text
packages/tools/src/builtins/objectives.ts
packages/tools/src/builtins/tasks.ts
packages/tools/src/index.ts
packages/tools/test/objectives.test.ts
packages/tools/test/tasks.test.ts
```

Work:

- Add `bindObjectiveStore`.
- Self-register objective tools.
- Export/bind from `packages/tools/src/index.ts`.
- Import `./builtins/objectives.js` in `index.ts` so tools self-register.
- Extend task tools with optional `objective_id`.

Mutating objective tools require active agent context:

```text
objective_create
objective_update
objective_attach_task
objective_detach_task
objective_close
objective_event
```

Read tools can be less strict if useful:

```text
objective_list
objective_view
```

Tool actor rules:

- `objective_create` defaults `owner_agent_id` and `created_by` to current agent.
- `owner_session_id` and `created_in_session_id` default to current session.
- `objective_close` should require owner agent unless called through a system/admin API path.
- `objective_attach_task` should validate both objective and task exist.

### `@openacme/server`

Files:

```text
packages/server/src/agent-manager.ts
packages/server/src/app.ts
packages/server/src/routes/objectives.ts
packages/server/src/index.ts
packages/server/src/objective-closeout-service.ts
packages/server/src/objective-closeout-watcher.ts
packages/server/src/objective-closeout-summarizer.ts
packages/server/test/objective-closeout-service.test.ts
packages/server/test/objective-closeout-watcher.test.ts
packages/server/test/objective-closeout-summarizer.test.ts
packages/server/test/dispatcher.test.ts
packages/server/test/e2e/objectives.e2e.ts
```

Work:

- Instantiate `objectiveStore = createObjectiveStore(this.db)` in `AgentManager`.
- Bind objective tools in `AgentManager`.
- Register objective routes in `app.ts` near task routes.
- Add `ObjectiveCloseoutService` with its own interval, serialization, budget,
  limit, timeout, and `start/stop/drain/kick` lifecycle.
- Add `ObjectiveCloseoutWatcher`.
- Add an injectable `ObjectiveCloseoutSummarizer` seam for bounded AI briefs.
- Start the closeout service in server startup after dispatcher startup.
- Stop/drain the closeout service before stopping/draining the dispatcher.
- After a closeout notice is delivered, call `dispatcher.kick("objective_closeout")`.
- Catch/log closeout service errors inside the service so task scheduling is not broken.

Important constraints:

- Do not mutate `sessions.kind` when objectives are created.
- Closeout notices should use `InboxStore.deliver`.
- If `owner_session_id` exists, the session exists, and it belongs to
  `owner_agent_id`, set `relatedSession` so the existing dispatcher
  targeted-session ordering wakes the right session.
- If `owner_session_id` is null, missing, or belongs to another agent, deliver
  agent-wide and append `owner_session_unavailable`; the dispatcher already
  supports agent-wide inbox.
- Do not broadcast objective events as task events unless a separate objective stream is added later.
- Summarizer failure must be recorded and must not block inbox delivery.
- Do not add objective scanning, summarization, or closeout packet assembly to
  `Dispatcher.tick()`.
- Reuse existing OpenAcme OTel bootstrap/span helpers; do not add a new
  telemetry bootstrap, exporter, or objective-specific observability layer.

### `@openacme/agent-core`

Files:

```text
packages/agent-core/src/agent.ts
packages/agent-core/src/prompt.ts
packages/agent-core/test/agent-preflight.test.ts
packages/agent-core/test/prompt.test.ts
```

Work:

- Add brief objective guidance only when objective tools are available.
- Keep guidance short. It should explain that objectives group tracked outcomes and create closeout wakes; they do not create sessions or tasks.
- Add optional bounded `objectivesContext` to `buildSystemPrompt`.
- Render the objectives snapshot alongside the existing task prompt snapshot.
- Ensure preflight token estimation counts the objectives snapshot as part of
  the system prompt.
- Test that large objective sets are bounded/truncated and still direct the
  agent to live read tools for fresh state.

### Web UI Later

Files later:

```text
apps/web/app/tasks/types.ts
apps/web/app/lib/types.ts
apps/web/app/routes/tasks.tsx
apps/web/app/tasks/detail.tsx
apps/web/test/tasks-types.test.ts
```

Work later:

- Mirror objective/task `objective_id` types.
- Show objective badge/link on task detail/card.
- Add objective list/detail only after core behavior is accepted.

UI is not part of the first backend acceptance.

## Formal Delivery Plan

### Delivery Rules

- Implement one milestone at a time.
- Keep each slice independently reviewable and testable.
- Start every behavioral slice with failing tests.
- Do not pull closeout service work into storage/tooling milestones.
- Do not modify dispatcher scheduling rules unless a focused regression test
  proves an objective-closeout wake cannot work otherwise.
- Do not add a new session kind, telemetry layer, approval system, recurrence
  system, or supervisor agent in V1.
- Keep docs and code aligned before moving to the next milestone.

### TDD Loop

Each implementation slice follows the same loop:

```text
1. Red: add the narrow failing test that describes the slice contract.
2. Green: implement the smallest code path that satisfies that test.
3. Refactor: clean local duplication without broadening behavior.
4. Regression: run the focused package tests for touched seams.
5. Contract check: confirm this document still matches code behavior.
```

### Milestone 0: Canonical Contract

Goal:

- Establish `docs/objective-layer-mvp-plan.md` as the repo-local source of truth.

Slice 0A: Repo doc

- Add this plan to the worktree.
- No runtime behavior changes.

Acceptance:

- The doc names branch/worktree, V1 semantics, non-goals, ticker isolation,
  summary budget policy, OTel reuse, and delivery plan.

Validation:

```text
review-only
```

Stop condition:

- No schema/code changes are required for this milestone.

### Milestone 1: Storage Shape

Goal:

- Add durable objective schema and task linkage without changing runtime
  behavior.

Slice 1A: Failing DB shape tests

TDD:

- Add failing assertions in `packages/db/test/clean-bootstrap.test.ts`.
- Assert:
  - `objectives` table exists.
  - `objective_events` table exists.
  - `tasks.objective_id` exists.
  - required objective/task indexes exist.

Slice 1B: Schema and migration

Implementation:

- Update `packages/db/src/schema.ts`.
- Add objective tables and indexes.
- Add nullable `tasks.objective_id`.
- Generate migration via `pnpm --filter @openacme/db db:generate`.
- Export schema/store types from `packages/db/src/index.ts` as needed.

Acceptance:

- Fresh DB bootstrap includes the new tables/columns/indexes.
- No runtime objective behavior exists yet.
- `sessions.kind` remains unchanged.

Validation:

```text
pnpm --filter @openacme/db test -- clean-bootstrap.test.ts
pnpm --filter @openacme/db check-types
```

Stop condition:

- Do not implement `ObjectiveStore` logic in this milestone unless needed for
  schema test compilation.

### Milestone 2: Objective Store And Ledger

Goal:

- Implement the SQL-backed objective aggregate and event ledger.

Slice 2A: Store contract tests

TDD:

- Add `packages/db/test/objective-store.test.ts`.
- Start with failing tests for create/get/list/update/event append.

Slice 2B: Lifecycle helpers

TDD:

- Add failing tests for completed/failed/canceled close helpers.
- Add failing tests for invalid status rejection.
- Add failing tests for internal owner cleanup:
  - `deleteObjectivesForOwner(agentId, actor)` deletes objectives owned by the
    agent.
  - objective events for cleaned-up objectives are removed or no longer listed.

Implementation:

- Add `packages/db/src/stores/objective-store.ts`.
- Follow existing DB store patterns, especially `comment-store.ts` style
  boundaries.
- Persist objective ledger events oldest-first.

Acceptance:

- Objective store creates objectives with owner fields.
- Objective ledger records creation, updates, close/fail/cancel events.
- Listing by owner/status works.
- Internal owner cleanup supports existing agent delete/orphan purge behavior.
- Store remains deterministic and does not call agents, dispatcher, inbox, or
  tools.

Validation:

```text
pnpm --filter @openacme/db test -- objective-store.test.ts
pnpm --filter @openacme/db check-types
```

Stop condition:

- Do not add task attachment tooling here; that belongs to tools/API.

### Milestone 3: Task Objective Link

Goal:

- Let existing tasks link to objectives without changing task execution.

Slice 3A: Task type/schema tests

TDD:

- Add failing tests in `packages/tasks/test/store.test.ts`.
- Assert file-backed task create/update/list can carry `objective_id`.

Slice 3B: SQL task store tests

TDD:

- Add failing tests in `packages/tasks/test/sql-store.test.ts`.
- Assert SQL create/update/list filter supports `objective_id`.

Implementation:

- Add `objective_id: string | null` to `TaskFrontmatterSchema`.
- Add `objective_id` to `TaskCreate`, `TaskUpdate`, and `TaskListFilter`.
- Add SQL row mapping, insert, update, and list filtering support.

Acceptance:

- Tasks can be linked/unlinked through `objective_id`.
- Existing create/update/list behavior remains unchanged when no objective is
  set.
- `TaskStore` does not validate objective existence by default.
- Task status transitions and session assignment behavior are unchanged.

Validation:

```text
pnpm --filter @openacme/tasks test -- sql-store.test.ts store.test.ts
pnpm --filter @openacme/tasks check-types
```

Stop condition:

- Do not introduce closeout detection or objective tools in this milestone.

### Milestone 4: API, Tools, And Agent Guidance

Goal:

- Make objectives usable by agents and HTTP clients while preserving existing
  task/session semantics.

Slice 4A: Objective tools

TDD:

- Add `packages/tools/test/objectives.test.ts`.
- Cover create/view/list/update/attach/detach/close/event.
- Cover active agent/session defaults for owner fields.
- Cover mutating tool actor requirements.
- Cover `objective_attach_task` reopening `ready_for_closeout` objectives when a
  nonterminal task is attached.
- Cover detach/delete semantics as cleanup: detached tasks no longer count as
  linked, but objective completion is not inferred.

Implementation:

- Add `packages/tools/src/builtins/objectives.ts`.
- Add `bindObjectiveStore`.
- Export/register objective tools from `packages/tools/src/index.ts`.
- Extend task tools with optional `objective_id`.

Slice 4B: Server API routes

TDD:

- Add server route/e2e tests for objective CRUD, linked task rollups, events,
  attach/detach, and close.
- Add tests that existing agent delete/orphan cleanup removes objectives owned
  by the deleted/missing agent, matching task cleanup behavior.

Implementation:

- Instantiate `objectiveStore = createObjectiveStore(this.db)` in
  `AgentManager`.
- Bind objective tools in `AgentManager`.
- Add `packages/server/src/routes/objectives.ts`.
- Register objective routes in `app.ts` near task routes.
- Wire objective owner cleanup into existing agent delete/orphan purge paths.

Slice 4C: Prompt guidance

TDD:

- Add/update `packages/agent-core/test/prompt.test.ts`.

Implementation:

- Add short guidance only when objective tools are available.
- Guidance must say objectives group tracked outcomes and closeout wakes; they
  do not create sessions or tasks by themselves.

Slice 4D: Session context and preflight snapshot

TDD:

- Add/update `packages/agent-core/test/prompt.test.ts`.
- Add/update `packages/agent-core/test/agent-preflight.test.ts`.
- Cover:
  - system prompt includes a bounded objectives snapshot when objectives exist.
  - snapshot includes relevant objective ids/statuses/linked task counts.
  - snapshot excludes task/comment bodies and closeout brief content.
  - large objective sets are truncated with counts/flags.
  - preflight token estimation counts the objectives snapshot.
  - snapshot text tells the agent to use live objective/task tools for fresh
    state.

Implementation:

- Add optional `objectivesContext` to `buildSystemPrompt`.
- Add an objective context renderer that mirrors `TaskStore.renderForPrompt`
  style, but remains bounded and read-only.
- Wire the renderer into `Agent.getSystemPrompt` without invalidating the
  existing cached system prompt model beyond normal session-start behavior.

Acceptance:

- Agent can create an objective owned by current agent/session.
- Agent can create or attach tasks under an objective.
- Objective view returns linked tasks and ledger.
- Owner can close completed/failed/canceled.
- Creating objectives never mutates `sessions.kind`.
- Agent delete/orphan cleanup removes owned objectives without adding a new
  objective status.
- Simple one-turn actions are not encouraged to create objectives.
- Normal session context includes compact objective orientation, not raw
  objective/task/comment payloads.
- Preflight compression/token estimation accounts for that objective
  orientation.

Validation:

```text
pnpm --filter @openacme/tools test -- objectives.test.ts tasks.test.ts
pnpm --filter @openacme/server test:e2e -- objectives.e2e.ts
pnpm --filter @openacme/agent-core test -- prompt.test.ts agent-preflight.test.ts
pnpm --filter @openacme/tools check-types
pnpm --filter @openacme/server check-types
pnpm --filter @openacme/agent-core check-types
```

Stop condition:

- Do not add `ObjectiveCloseoutService` in this milestone. Agents can manage
  objectives manually after tools/API land.

### Milestone 5: Closeout Service

Goal:

- Wake the owner when all linked tasks are terminal, with a deterministic packet
  and optional compact AI brief, without risking the dispatcher ticker.

Slice 5A: Deterministic watcher and packet builder

TDD:

- Add `packages/server/test/objective-closeout-watcher.test.ts`.
- Cover:
  - nonterminal linked tasks remain waiting.
  - all terminal linked tasks move to `ready_for_closeout`.
  - no-task objectives are ignored.
  - deleted/detached tasks no longer count as linked or terminal.
  - recurring linked tasks that reset to `open` do not trigger closeout on every
    recurrence run.
  - fingerprint prevents repeated identical notices.
  - `ready_for_closeout` objectives with matching fingerprint but no
    `owner_wake_requested` event are eligible for notice retry.
  - watcher does not create tasks.
  - watcher does not complete/fail/cancel objectives.
  - deterministic packet includes objective context, task rollup, result
    excerpts, system warning excerpts, and recent comment excerpts.

Implementation:

- Add `packages/server/src/objective-closeout-watcher.ts`.

Slice 5B: Bounded summarizer and compression

TDD:

- Add `packages/server/test/objective-closeout-summarizer.test.ts`.
- Cover:
  - output budget selection from configured override/default, model max output,
    and service cap.
  - input budget derived from model context minus prompt/output/headroom.
  - char fallback only when tokenizer/model metadata is unavailable.
  - under-budget combined input uses one objective summary call.
  - oversized task evidence gets task-scoped compression.
  - oversized comments chunk deterministically with source references.
  - chunk cap overflow records `comment_chunk_budget_exceeded`.
  - metadata plus manifest overflow skips AI with `input_budget_exceeded`.
  - summarizer timeout/failure returns deterministic fallback.

Implementation:

- Add `packages/server/src/objective-closeout-summarizer.ts`.
- Keep output compact for the owner agent's next turn.
- Do not add unbounded recursive summarization.

Slice 5C: Service lifecycle and ticker isolation

TDD:

- Add `packages/server/test/objective-closeout-service.test.ts`.
- Cover:
  - interval/kick serialization.
  - per-check objective limit and wall-clock budget.
  - inbox notice delivery after new terminal fingerprint.
  - `dispatcher.kick("objective_closeout")` only after inbox delivery.
  - DB/inbox failure retries on the next check.
  - summary/compression failure does not block deterministic wake.
  - service stop/drain prevents new closeout work during shutdown.

Implementation:

- Add `packages/server/src/objective-closeout-service.ts`.
- Wire service in `AgentManager`.
- Start after `dispatcher.start()`.
- Stop/drain before `dispatcher.stop()` / `dispatcher.drain()`.

Slice 5D: Owner wake and dispatcher regression

TDD:

- Add/adjust focused `packages/server/test/dispatcher.test.ts` cases.
- Prove objective closeout notice wakes the owner target session.
- Prove missing or mismatched `owner_session_id` falls back to agent-wide inbox
  delivery instead of losing the wake.
- If owner session is taskless chat and current rules block the wake, fix only
  the narrow `system:objective-closeout` routing rule.
- Current `InboxStore.pendingSummaryFor` exposes targeted sessions and user
  attention buckets, but not `sourceId`. If the narrow routing fix is needed,
  extend that summary with an objective-closeout-specific targeted bucket
  derived from `sourceId: "system:objective-closeout"` instead of treating all
  `system_notice` rows as chat wake signals.

Acceptance:

- No objective scan, packet build, compression, or AI summary call happens
  inside `Dispatcher.tick()`.
- Dispatcher task scheduling behavior remains unchanged.

Slice 5E: OTel visibility using existing seams

TDD:

- Add tests or span-helper spies proving closeout spans use the existing
  OpenAcme span helper pattern.

Implementation:

- Reuse `@openacme/config/telemetry-bootstrap`.
- Reuse `withOpenAcmeSpan` / sanitized attribute pattern from
  `@openacme/llm-provider`.
- Do not add a new telemetry bootstrap/exporter/objective observability layer.

Acceptance:

- Closeout failures are visible through existing spans/logs.
- Objective-specific failures append ledger events when possible.
- Metrics names are reserved for existing OTel metrics support, but lack of a
  metrics exporter does not block V1.

Validation:

```text
pnpm --filter @openacme/server test -- objective-closeout-service.test.ts objective-closeout-watcher.test.ts objective-closeout-summarizer.test.ts dispatcher.test.ts
pnpm --filter @openacme/server check-types
```

Stop condition:

- Do not add UI changes in this milestone.

### Milestone 6: Minimal UI Read Surface

Goal:

- Make objectives visible without changing task execution UX.

Slice 6A: Web types

TDD:

- Add/update web type tests for objective DTOs and task `objective_id`.

Slice 6B: Read-only objective views

Implementation:

- Add objective list/detail if low-risk.
- Show objective badge/link on task detail/card.
- Add task board objective filter only if it stays small.

Acceptance:

- UI is read-oriented for V1.
- No UI workflow creates new orchestration semantics.

Validation:

```text
pnpm --filter web test -- objectives-types.test.ts tasks-types.test.ts
pnpm --filter web check-types
```

Stop condition:

- UI is not required for backend V1 acceptance.

## Focused Validation Matrix

Per milestone:

```text
M1: pnpm --filter @openacme/db test -- clean-bootstrap.test.ts
M2: pnpm --filter @openacme/db test -- objective-store.test.ts
M3: pnpm --filter @openacme/tasks test -- sql-store.test.ts store.test.ts
M4: pnpm --filter @openacme/tools test -- objectives.test.ts tasks.test.ts
M4: pnpm --filter @openacme/server test:e2e -- objectives.e2e.ts
M4: pnpm --filter @openacme/agent-core test -- prompt.test.ts agent-preflight.test.ts
M5: pnpm --filter @openacme/server test -- objective-closeout-service.test.ts objective-closeout-watcher.test.ts objective-closeout-summarizer.test.ts dispatcher.test.ts
M6: pnpm --filter web test -- objectives-types.test.ts tasks-types.test.ts
```

Final backend acceptance:

```text
pnpm --filter @openacme/db check-types
pnpm --filter @openacme/tasks check-types
pnpm --filter @openacme/tools check-types
pnpm --filter @openacme/server check-types
pnpm --filter @openacme/agent-core check-types
```

## First Slice To Implement

Recommended first implementation slice:

```text
Milestone 0 + Milestone 1
```

Concrete goal:

- Keep `docs/objective-layer-mvp-plan.md` as the canonical contract.
- Add failing DB bootstrap assertions for `objectives`, `objective_events`, and
  `tasks.objective_id`.
- Update schema.
- Generate migration.
- Pass DB bootstrap test and DB typecheck.

This slice creates durable shape without touching dispatcher/session behavior.

## Implementation Progress

### Completed: Milestone 0

Evidence:

- `docs/objective-layer-mvp-plan.md` is the repo-local canonical contract.
- Memory copy is kept at
  `memory/references/objective-layer-implementation-plan.md`.

### Completed: Milestone 1

Evidence:

- `packages/db/src/schema.ts` defines `OBJECTIVE_STATUSES`, `objectives`,
  `objective_events`, and `tasks.objective_id`.
- `packages/db/test/clean-bootstrap.test.ts` asserts fresh DB table, column, and
  index shape.
- Migration generated:
  `packages/db/drizzle/0021_round_sabra.sql`.
- Validation:
  `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts objective-store.test.ts`
  passed on 2026-08-11.
- Validation: `pnpm --filter @openacme/db check-types` passed on 2026-08-11.

### Completed: Milestone 2

Evidence:

- `packages/db/src/stores/objective-store.ts` implements the SQL-backed
  objective aggregate and objective ledger.
- `packages/db/src/index.ts` exports the objective store, error, status/type
  helpers, schema tables, and schema-derived row types.
- `packages/db/test/objective-store.test.ts` covers create/get/list/update,
  ledger append/list, close/fail/cancel helpers, invalid status rejection,
  closeout brief snapshot storage, and owner cleanup with ledger cascade.
- Validation:
  `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts objective-store.test.ts`
  passed on 2026-08-11.
- Validation: `pnpm --filter @openacme/db check-types` passed on 2026-08-11.

### Completed: Milestone 3

Evidence:

- `packages/tasks/src/types.ts` adds `objective_id: string | null` to task
  frontmatter, create input, update input, and list filter.
- `packages/tasks/src/store.ts` carries `objective_id` through file-backed task
  create/update/read/list and SQL-backed row mapping, insert, update, and list
  filtering.
- `TaskStore` still does not validate objective existence, call
  `ObjectiveStore`, alter task status transitions, or trigger closeout
  behavior.
- `packages/tasks/test/store.test.ts` covers file-backed objective link
  roundtrip, clearing, default null, and list filtering.
- `packages/tasks/test/sql-store.test.ts` covers legacy markdown import into
  SQL, SQL create/update/clear, and SQL list filtering by `objective_id`.
- Validation:
  `pnpm --filter @openacme/tasks test -- store.test.ts sql-store.test.ts`
  passed on 2026-08-11.
- Validation: `pnpm --filter @openacme/tasks check-types` passed on
  2026-08-11.

### Completed: Milestone 4A

Evidence:

- `packages/tools/src/builtins/objectives.ts` adds objective agent tools:
  `objective_create`, `objective_view`, `objective_list`, `objective_update`,
  `objective_attach_task`, `objective_detach_task`, `objective_close`, and
  `objective_event`.
- `packages/tools/src/index.ts` exports `bindObjectiveStore` and imports the
  objective builtin for self-registration.
- `packages/tools/src/builtins/tasks.ts` accepts `objective_id` in
  `task_create`, `task_update`, and `task_list`.
- Objective tools require active agent context for mutating operations.
- `objective_create` defaults owner/creator fields from the current
  agent/session.
- `objective_close` is owner-only through the agent tool surface.
- `objective_attach_task` validates objective and task existence, links the
  task through `TaskStore.update`, reopens `ready_for_closeout` objectives when
  nonterminal work is attached, and appends objective ledger events.
- `TaskStore` remains objective-existence agnostic; validation lives in the
  objective-aware tool.
- `packages/tools/test/objectives.test.ts` covers objective tool create,
  view/list/update/event/close, owner close enforcement, attach/detach, and
  ready-objective reopen behavior.
- `packages/tools/test/tasks.test.ts` covers task tool create/update/list
  support for `objective_id`.
- Validation:
  `pnpm --filter @openacme/tools test -- objectives.test.ts tasks.test.ts`
  passed on 2026-08-11.
- Validation: `pnpm --filter @openacme/tools check-types` passed on
  2026-08-11 after building workspace dependency declarations for
  `@openacme/browser`, `@openacme/email`, and `@openacme/memory`.

### Completed: Milestone 4B

Evidence:

- `packages/server/src/agent-manager.ts` instantiates `objectiveStore` with
  `createObjectiveStore(this.db)`.
- `AgentManager` binds objective tools with both `objectiveStore` and
  `taskStore`.
- Existing agent delete and orphan cleanup paths now remove objectives owned by
  deleted/missing agents, matching current task cleanup behavior.
- `packages/server/src/routes/objectives.ts` adds HTTP routes for objective
  list/create/view/update/events/attach/detach/close.
- Objective list/detail routes include linked task rollups and do not expose
  task bodies.
- HTTP close is a system/admin route; owner-only close remains enforced by the
  agent tool surface.
- `packages/server/src/app.ts` registers objective routes next to task routes.
- `packages/server/test/app-routes.test.ts` covers objective CRUD, events,
  task attach/detach rollups, and agent-delete objective cleanup.
- Validation:
  `pnpm --filter @openacme/server test -- app-routes.test.ts` passed on
  2026-08-11.
- Validation: `pnpm --filter @openacme/server check-types` passed on
  2026-08-11.

### Completed: Milestone 4C

Evidence:

- `packages/tools/src/system.ts` adds objective tools to the always-available
  `SYSTEM_TOOLS` set so normal agents receive the objective tool surface.
- `packages/tools/test/system.test.ts` pins objective tool exposure for
  `objective_create`, `objective_view`, `objective_list`,
  `objective_update`, `objective_attach_task`, `objective_detach_task`,
  `objective_close`, and `objective_event`.
- `packages/agent-core/src/prompt.ts` adds short objective guidance gated on
  `objective_create`.
- The guidance says objectives group tracked outcomes, do not create sessions
  or tasks by themselves, should not be used for simple one-turn actions, and
  require live objective/task reads before closeout decisions.
- `packages/agent-core/test/prompt.test.ts` covers guidance inclusion and
  omission based on objective tool availability.
- Validation:
  `pnpm --filter @openacme/tools test -- system.test.ts objectives.test.ts tasks.test.ts`
  passed on 2026-08-11.
- Validation:
  `pnpm --filter @openacme/agent-core test -- prompt.test.ts` passed on
  2026-08-11.
- Validation: `pnpm --filter @openacme/tools check-types` passed on
  2026-08-11.
- Validation: `pnpm --filter @openacme/agent-core check-types` passed on
  2026-08-11.

### Completed: Milestone 4D

Evidence:

- `packages/agent-core/src/objectives-context.ts` adds a bounded objective
  snapshot renderer.
- The renderer includes relevant objectives owned by the agent, created in the
  session, or linked to tasks in the session.
- The snapshot includes compact fields only: objective id/title/status,
  owner agent/session, linked task counts, terminal/nonterminal counts,
  closeout fingerprint presence, and closeout prompt excerpt.
- The snapshot excludes task bodies, comments, objective descriptions, and
  closeout brief JSON.
- Large relevant objective sets are truncated with a count.
- `packages/agent-core/src/prompt.ts` accepts `objectivesContext` and renders it
  as `## Objectives` separately from objective tool guidance.
- `packages/agent-core/src/agent.ts` renders objectives into the cached
  session-start system prompt only when an objective store exists and objective
  tools are available.
- `packages/server/src/agent-manager.ts` passes the shared objective store into
  each agent.
- `packages/agent-core/test/objectives-context.test.ts` covers relevance,
  compact field rendering, body/brief exclusion, and truncation.
- `packages/agent-core/test/prompt.test.ts` covers prompt snapshot assembly.
- `packages/agent-core/test/agent-preflight.test.ts` proves the objectives
  snapshot is counted by preflight request token estimation.
- Validation:
  `pnpm --filter @openacme/agent-core test -- objectives-context.test.ts prompt.test.ts agent-preflight.test.ts`
  passed on 2026-08-11.
- Validation: `pnpm --filter @openacme/agent-core check-types` passed on
  2026-08-11.
- Validation: `pnpm --filter @openacme/agent-core build` passed on
  2026-08-11 so dependent package declarations include the new constructor
  dependency.
- Validation: `pnpm --filter @openacme/server check-types` passed on
  2026-08-11.
- Validation:
  `pnpm --filter @openacme/server test -- app-routes.test.ts` passed on
  2026-08-11.

### Completed: Milestone 5A

Evidence:

- `packages/server/src/objective-closeout-watcher.ts` adds the deterministic
  `ObjectiveCloseoutWatcher` core.
- The watcher scans bounded active/waiting/ready objectives and ignores
  objectives with no linked tasks.
- It treats `done` and `canceled` linked tasks as terminal for wake eligibility
  only.
- It ignores detached/deleted tasks because they no longer appear as linked
  tasks.
- Recurring tasks that have reset to nonterminal `open` do not trigger
  closeout.
- It computes a deterministic fingerprint from linked task ids, statuses,
  `closed_at`, and `updated_at`.
- It builds a deterministic closeout packet with objective metadata, linked
  task rollups, latest result/system comment excerpts, and recent bounded
  comment excerpts.
- It sets eligible objectives to `ready_for_closeout`, records the closeout
  packet/fingerprint snapshot, and appends `linked_tasks_terminal`.
- It returns owner wake candidates but does not deliver inbox notices, kick the
  dispatcher, create tasks, or close objectives. Those remain Milestone 5C/5D
  work.
- It suppresses duplicate candidates only after an `owner_wake_requested`
  ledger event exists for the same fingerprint; otherwise a
  `ready_for_closeout` objective remains eligible for retry.
- `packages/server/test/objective-closeout-watcher.test.ts` covers
  nonterminal/no-task ignore behavior, all-terminal ready transition and
  packet shape, deleted/detached/recurring-reset semantics, and fingerprint
  retry suppression.
- Validation:
  `pnpm --filter @openacme/server test -- objective-closeout-watcher.test.ts`
  passed on 2026-08-11.
- Validation: `pnpm --filter @openacme/server check-types` passed on
  2026-08-11.

### Completed: Milestone 5B

Evidence:

- `packages/server/src/objective-closeout-summarizer.ts` adds an injectable
  `ObjectiveCloseoutSummarizer` seam.
- The summarizer derives output budget from configured/default output,
  model max output, and service output cap.
- It derives input budget from model context minus prompt/instruction/output
  budget and safety headroom, with char fallback when model context metadata is
  unavailable.
- The common under-budget path performs one objective summary model call.
- Oversized task evidence is compressed before the objective summary call.
- Oversized comments are split into deterministic bounded chunks with source
  references and chunk cap overflow is recorded as
  `comment_chunk_budget_exceeded`.
- If objective metadata plus the task manifest exceeds the input budget, the
  summarizer skips AI and returns a deterministic `input_budget_exceeded`
  fallback.
- Model failure and timeout return deterministic fallback results with no
  thrown error to the caller.
- The summarizer seam is injectable. Production service wiring now provides a
  real structured-output model caller when the root model is configured; when
  unavailable or failed, deterministic closeout wake delivery still proceeds
  and the objective ledger records `closeout_brief_failed`.
- `packages/server/src/objective-closeout-model-caller.ts` adapts the seam to
  the configured model, caps owner brief output at 600 tokens, uses streaming
  structured output for OpenAI OAuth models, and uses non-streaming structured
  output for other providers.
- `packages/server/test/objective-closeout-summarizer.test.ts` covers budget
  derivation, single-call packing, task evidence compression, deterministic
  chunking and chunk cap overflow, manifest overflow skip behavior, and
  failure/timeout fallback.
- `packages/server/test/objective-closeout-model-caller.test.ts` covers the
  OpenAI OAuth streaming branch and the non-streaming provider branch.
- Validation:
  `pnpm --filter @openacme/server test -- objective-closeout-summarizer.test.ts objective-closeout-watcher.test.ts`
  passed on 2026-08-11.
- Validation: `pnpm --filter @openacme/server check-types` passed on
  2026-08-11.

### Completed: Milestone 5C

Evidence:

- `packages/server/src/objective-closeout-service.ts` adds
  `ObjectiveCloseoutService`.
- The service owns its own interval and `kick(reason)` entrypoint.
- The service serializes checks with `checkInFlight`/`checkAgain` so interval
  and manual kicks do not overlap.
- The service passes bounded scan options to the watcher:
  `limit` and `budgetMs`.
- The service delivers owner closeout notices through `InboxStore.deliver`
  only after the watcher returns wake candidates.
- Closeout notices use `kind: "system_notice"`, `source: "system"`,
  `sourceId: "system:objective-closeout"`, and carry objective id, linked task
  ids, deterministic closeout packet, optional closeout brief, and closeout
  prompt.
- Owner session routing follows the existing-behavior decision:
  matching owner session gets `relatedSession`; missing/mismatched owner
  session falls back to agent-wide delivery and appends
  `owner_session_unavailable`.
- `dispatcher.kick("objective_closeout")` happens only after inbox delivery
  succeeds. Ledger append failures after delivery are logged but do not prevent
  the dispatcher kick.
- Inbox delivery failure does not append `owner_wake_requested` and does not
  kick the dispatcher, so the next check can retry.
- Summary failure or unavailable summarizer records `closeout_brief_failed` and
  does not block deterministic wake delivery.
- `stop()` clears the interval and suppresses queued follow-up checks;
  `drain()` waits for the current closeout check with a timeout.
- `packages/server/src/agent-manager.ts` instantiates the closeout service with
  the shared objective store, task store, inbox store, session store, watcher,
  and dispatcher.
- `packages/server/src/index.ts` starts the objective closeout service after
  `dispatcher.start()`.
- `AgentManager.close()` stops/drains the objective closeout service before
  stopping/draining the dispatcher.
- No objective scan, packet build, summary call, or inbox delivery is added to
  `Dispatcher.tick()`.
- `packages/server/test/objective-closeout-service.test.ts` covers interval
  checks, kick serialization, bounded check options, owner notice delivery,
  owner-session fallback, inbox retry, ledger failure isolation, summary
  failure fallback, and stop/drain behavior.
- Validation:
  `pnpm --filter @openacme/server test -- objective-closeout-service.test.ts objective-closeout-watcher.test.ts objective-closeout-summarizer.test.ts`
  passed on 2026-08-11.
- Validation:
  `pnpm --filter @openacme/server test -- app-routes.test.ts` passed on
  2026-08-11.
- Validation: `pnpm --filter @openacme/server check-types` passed on
  2026-08-11.

### Completed: Milestone 5D

Evidence:

- `packages/db/src/stores/inbox-store.ts` now exposes objective-closeout inbox
  buckets in `pendingSummaryFor`:
  `objectiveCloseoutSessionIds` and `hasObjectiveCloseoutAgentWide`.
- Objective closeout inbox classification is keyed only by
  `kind: "system_notice"` plus `sourceId: "system:objective-closeout"`.
- `packages/server/src/dispatcher.ts` separates generic `hasInbox` from
  `hasChatWakeInbox` for taskless chat sessions.
- Generic targeted `system_notice` rows no longer autonomously wake a taskless
  chat session.
- Targeted objective closeout notices do wake the owner chat session.
- Agent-wide objective closeout notices also wake an owner session, preserving
  the missing/mismatched `owner_session_id` fallback path.
- Task sessions still use the existing broad inbox wake behavior; objective
  closeout adds no objective scan, packet build, compression, or summary call to
  `Dispatcher.tick()`.
- `packages/db/test/stores.test.ts` covers objective-closeout pending summary
  buckets.
- `packages/server/test/dispatcher.test.ts` covers generic system notice
  suppression for taskless chat, targeted objective closeout wake, and
  agent-wide objective closeout wake.
- Validation: `pnpm --filter @openacme/db build` passed on 2026-08-11.
- Validation: `pnpm --filter @openacme/db test -- stores.test.ts` passed on
  2026-08-11.
- Validation: `pnpm --filter @openacme/db check-types` passed on 2026-08-11.
- Validation:
  `pnpm --filter @openacme/server test -- objective-closeout-service.test.ts objective-closeout-watcher.test.ts objective-closeout-summarizer.test.ts dispatcher.test.ts`
  passed on 2026-08-11.
- Validation: `pnpm --filter @openacme/server check-types` passed on
  2026-08-11.

### Completed: Milestone 5E

Evidence:

- `packages/server/src/objective-closeout-service.ts` now wraps the closeout
  cycle in existing OpenAcme spans from `@openacme/llm-provider`.
- Service spans added:
  - `objective.closeout.check`
  - `objective.closeout.deliver_notice`
- Check spans record closeout reason, bounded limit/budget, scanned count,
  ready count, and failure result. Watcher exceptions are recorded on the span
  and still logged without crashing the service.
- Delivery spans record objective status, terminality rollup counts, summary
  status attributes, notice delivery result, and dispatcher kick result.
- Inbox delivery failure records a span exception plus
  `notice.delivered: false` and still preserves the existing retry behavior.
- `packages/server/src/objective-closeout-summarizer.ts` now wraps summary and
  compression work in existing OpenAcme spans.
- Summarizer spans added:
  - `objective.closeout.summarize`
  - `objective.closeout.compress_task_evidence`
- Summary spans record bounded output budget, objective/task rollup counts,
  result status, summary usage, truncation, compression use, and failure
  reason.
- Compression spans record chunked/nonchunked mode and bounded counts only.
- No new telemetry bootstrap, exporter, package, or objective-specific
  observability layer was added.
- Span attributes avoid task/comment bodies, comment excerpts, result text,
  summary text, task id lists, session ids, and owner ids. `objective.id` is
  used only on trace spans where the plan allowed high-cardinality objective
  correlation.
- `packages/server/test/objective-closeout-service.test.ts` uses a
  `withOpenAcmeSpan` spy to prove service closeout spans go through the
  existing helper.
- `packages/server/test/objective-closeout-summarizer.test.ts` uses the same
  helper spy pattern to prove summary and compression spans go through the
  existing helper.
- Validation:
  `pnpm --filter @openacme/server test -- objective-closeout-service.test.ts objective-closeout-summarizer.test.ts`
  passed on 2026-08-11.
- Validation:
  `pnpm --filter @openacme/server test -- objective-closeout-service.test.ts objective-closeout-watcher.test.ts objective-closeout-summarizer.test.ts dispatcher.test.ts`
  passed on 2026-08-11.
- Validation: `pnpm --filter @openacme/server check-types` passed on
  2026-08-11.

### Completed: Milestone 6A

Evidence:

- `apps/web/app/objectives/types.ts` adds static web DTO mirrors for objective
  read APIs without importing node/server packages.
- The web objective mirror includes:
  - `ObjectiveStatus`
  - `Objective`
  - `ObjectiveRollup`
  - `ObjectiveListItem`
  - `ObjectivesListResponse`
  - `ObjectiveDetailResponse`
  - `ObjectiveEvent`
  - `ObjectiveEventsResponse`
- `apps/web/app/tasks/types.ts` now includes nullable `objective_id` on the
  mirrored `Task` DTO.
- Existing web task test helpers now default `objective_id` to `null`,
  matching unlinked task rows.
- No web UI workflow, creation path, objective orchestration behavior, task
  board filter, or visual component was added in this slice.
- `apps/web/test/objectives-types.test.ts` covers V1 objective statuses and
  list/detail/event response shapes.
- `apps/web/test/tasks-types.test.ts` covers task `objective_id`.
- Validation:
  `pnpm --filter web test -- objectives-types.test.ts tasks-types.test.ts task-activity-filter.test.ts task-dependency-graph.test.ts`
  passed on 2026-08-11.
- Validation: `pnpm --filter web check-types` passed on 2026-08-11.

### Completed: Milestone 6B

Evidence:

- `apps/web/app/routes/objectives.tsx` adds a read-only `/objectives` page.
- The page reads only existing objective APIs:
  - `GET /api/objectives?limit=200`
  - `GET /api/objectives/:id`
- The page provides objective list, search, status badge, owner, terminal task
  progress, detail metadata, closeout prompt, and linked task rows.
- Linked task rows navigate to the existing task detail route. No task or
  objective mutation path was added.
- `apps/web/app/objectives/view-model.ts` adds small pure helpers for status
  labels, badge variants, sorting, filtering, and terminal progress labels.
- `apps/web/app/components/Sidebar.tsx`,
  `apps/web/app/components/MobileTabBar.tsx`, and
  `apps/web/app/routeTree.gen.ts` expose the new read-only route.
- `apps/web/app/tasks/row.tsx`, `apps/web/app/tasks/board.tsx`, and
  `apps/web/app/tasks/detail.tsx` show objective links when a task has
  `objective_id`.
- `apps/web/app/lib/CurrentViewContext.tsx` includes `objective` as a current
  view entity so the ambient panel can see the read-only objective context.
- No objective creation workflow, closeout workflow, task board objective
  filter, dispatcher behavior, or orchestration semantics were added in the UI.
- `apps/web/test/objectives-view-model.test.ts` covers objective read view
  sorting, filtering, status presentation, and progress labels.
- Validation:
  `pnpm --filter web test -- objectives-view-model.test.ts objectives-types.test.ts tasks-types.test.ts`
  passed on 2026-08-11.
- Validation: `pnpm --filter web check-types` passed on 2026-08-11.
- Validation: `pnpm --filter web build` passed on 2026-08-11.

### Readiness Review: 2026-08-11

Status:

- The product/design decisions are ready for implementation. The plan now has
  one clear V1 intention: objectives group tasks and wake the owner for
  closeout; they do not plan, supervise, verify, create sessions, or close
  themselves.
- The existing-behavior edge decisions are resolved enough to proceed:
  session delete keeps current task-like cleanup/rebind behavior; agent
  delete/orphan cleanup deletes owned objectives; task delete/detach does not
  imply objective completion; recurring tasks are allowed but do not produce
  repeated closeouts while they reset to `open`.
- The closeout watcher/service boundary is sufficiently safe: it remains
  outside `Dispatcher.tick()`, uses bounded scans, treats AI summary as
  optional briefing, delivers deterministic wakes even on summary failure, and
  reuses existing OTel seams.

Milestone status:

- Complete through Milestone 6B. Storage, ledger, task linkage, agent tools,
  HTTP routes, prompt/session context, closeout watcher/service, owner wake
  routing, closeout summary budgeting, existing OTel span integration, and the
  minimal read-only UI are implemented and validated.

Final acceptance validation:

- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts objective-store.test.ts stores.test.ts`
  passed on 2026-08-11.
- `pnpm --filter @openacme/tasks test -- store.test.ts sql-store.test.ts`
  passed on 2026-08-11.
- `pnpm --filter @openacme/tools test -- system.test.ts objectives.test.ts tasks.test.ts`
  passed on 2026-08-11.
- `pnpm --filter @openacme/agent-core test -- objectives-context.test.ts prompt.test.ts agent-preflight.test.ts`
  passed on 2026-08-11.
- `pnpm --filter @openacme/server test -- app-routes.test.ts objective-closeout-service.test.ts objective-closeout-watcher.test.ts objective-closeout-summarizer.test.ts dispatcher.test.ts`
  passed on 2026-08-11.
- `pnpm --filter web test -- objectives-view-model.test.ts objectives-types.test.ts tasks-types.test.ts task-activity-filter.test.ts task-dependency-graph.test.ts`
  passed on 2026-08-11.
- Package typechecks for `@openacme/db`, `@openacme/tasks`, `@openacme/tools`,
  `@openacme/agent-core`, `@openacme/server`, and `web` passed on 2026-08-11.
- Package builds for `@openacme/db`, `@openacme/tasks`, `@openacme/tools`,
  `@openacme/agent-core`, `@openacme/server`, and `web` passed on 2026-08-11.

Readiness conclusion:

- No open V1 design decision remains based on the latest decisions.
- The implementation is ready for code review and broader integration testing.

### Live Agent Smoke: 2026-08-11

An isolated real-model smoke was run against a temporary data directory copied
from local OpenAcme OAuth/config state. The smoke used a real listening server,
real OpenAI OAuth model calls, real agent turns, real objective/task tools, and
the closeout service. The temporary real-model e2e file was removed afterward
because it depends on local OAuth state and should not run in normal CI.

Cases validated:

- A simple one-turn request did not create an objective or task.
- A tracked multi-step request created one objective; the original session
  stayed `chat`.
- The owner agent created a task linked with `objective_id`.
- The owner agent added a `result` task comment.
- A terminal linked task moved the objective to `ready_for_closeout` and wrote
  `linked_tasks_terminal` plus `owner_wake_requested`.
- The owner agent used `objective_view` and `objective_close` to close the
  objective as `completed`.

Live-smoke fixes made:

- `objective_create` now treats blank model-supplied `owner_agent_id` and
  blank/null `owner_session_id` as absent and defaults them to the current
  agent/session. A real model produced this exact blank-owner shape.
- Failed/null closeout brief snapshots no longer write
  `closeout_brief_generated`; the ledger now records only
  `closeout_brief_failed` for unavailable summaries.
- Closeout summary wiring was validated with a real-model smoke where all
  linked tasks were terminal but one task explicitly said rollback could not be
  validated and another carried a localization warning. The generated brief
  correctly returned `objective_completion_assessment: "needs_follow_up"`,
  `suggested_owner_action: "add_followup_task"`, high confidence, task-level
  concerns, warnings, and concrete follow-up recommendations instead of
  recommending `close_completed`.
- The live summary smoke exposed two integration fixes: OpenAI OAuth structured
  output must use streaming (`streamObject`), and response-format schemas must
  make every declared property required while allowing empty arrays/nulls as
  values.

### Hardening: 2026-08-12

Follow-up hardening after live objective/task behavior checks:

- Parent/subtask guidance is now explicit in the task prompt and `task_create`
  tool schema. Agents should use `parent_id` only for a real parent/checklist
  or workstream shape, not as a decorative grouping substitute for objectives.
- Guidance now states that parent/subtask hierarchy is for visibility and
  structure, while `depends_on` remains the execution gate. If a parent task
  belongs to an objective, the parent and all subtasks should be linked to the
  same `objective_id`.
- Production closeout summary wiring now has a non-live regression test:
  `packages/server/test/objective-closeout-wiring.test.ts` boots `createApp`,
  runs the real `ObjectiveCloseoutService`, uses a mocked structured model
  call, and proves the closeout brief snapshot is persisted.
- The model caller has provider-shape coverage:
  `packages/server/test/objective-closeout-model-caller.test.ts` proves OpenAI
  OAuth uses streaming structured output and non-OAuth providers use
  non-streaming structured output.

Validation:

- `pnpm --filter @openacme/agent-core test -- prompt.test.ts` passed on
  2026-08-12.
- `pnpm --filter @openacme/tools test -- tasks.test.ts objectives.test.ts`
  passed on 2026-08-12.
- `pnpm --filter @openacme/server test -- objective-closeout-wiring.test.ts objective-closeout-model-caller.test.ts objective-closeout-service.test.ts objective-closeout-summarizer.test.ts objective-closeout-watcher.test.ts`
  passed on 2026-08-12.
- `pnpm --filter @openacme/agent-core check-types`,
  `pnpm --filter @openacme/tools check-types`, and
  `pnpm --filter @openacme/server check-types` passed on 2026-08-12.

### Release Candidate Validation: 2026-08-12

Targeted regression suite passed before local-stage rollout:

- `pnpm --filter @openacme/db test -- objective-store.test.ts clean-bootstrap.test.ts stores.test.ts`
- `pnpm --filter @openacme/tasks test -- store.test.ts sql-store.test.ts`
- `pnpm --filter @openacme/tools test -- tasks.test.ts objectives.test.ts system.test.ts`
- `pnpm --filter @openacme/agent-core test -- prompt.test.ts objectives-context.test.ts agent-preflight.test.ts`
- `pnpm --filter @openacme/server test -- app-routes.test.ts dispatcher.test.ts objective-closeout-watcher.test.ts objective-closeout-summarizer.test.ts objective-closeout-service.test.ts objective-closeout-model-caller.test.ts objective-closeout-wiring.test.ts`
- `pnpm --filter web test -- objectives-view-model.test.ts objectives-types.test.ts tasks-types.test.ts task-activity-filter.test.ts task-dependency-graph.test.ts`

Package typechecks passed:

- `pnpm --filter @openacme/db check-types`
- `pnpm --filter @openacme/tasks check-types`
- `pnpm --filter @openacme/tools check-types`
- `pnpm --filter @openacme/agent-core check-types`
- `pnpm --filter @openacme/server check-types`
- `pnpm --filter web check-types`

### Planned Hardening: Self-Task Defer Reset

Date: 2026-08-13.

#### Live Finding

Live objective/task usage exposed a defer edge case in session
`2277b450-2d97-48ad-83d9-47a7cb8a1b46`.

The session started as a normal `chat` session and later had objective-linked
self-assigned coordination task `1228` bound to the same session. The agent had
previously called `defer_session("24h")`, leaving a sticky
`sessions.defer_until` marker. In a later interactive turn, the same agent
created task `1228`, bound it to the current session, and marked it
`in_progress`. Because the actor, assignee, and creator were the same agent, no
new inbox row targeted the same session. The next routine dispatcher pass saw
`task_in_progress` work but skipped the wake because the older sticky defer was
still active:

```text
session.dispatcher.defer.skipped
taskId: 1228
reason: task_in_progress
hasInbox: false
```

A later user task comment did wake the same session through the normal inbox
bypass path, proving sticky defer still behaves correctly for real signals. The
gap is narrower: old sticky defer can suppress newly created same-session
self-work when the agent itself creates or activates that work and no external
signal is emitted.

#### Goal

Keep sticky defer as the default scheduler protection, but clear a session's
stale defer marker when the current agent makes its own current-session task
actionable.

Success means:

- `defer_session(...)` still suppresses routine tick spam after signal-driven
  wakes.
- Inbox/user/comment/objective signals still bypass defer without clearing it.
- If an agent creates or activates a self-assigned task bound to its current
  session, old defer no longer prevents routine `task_in_progress` wake.
- If the agent still wants quiet time after creating the new active work, it can
  explicitly call `defer_session(...)` again in the same turn.

#### Non-Goals

- Do not remove sticky defer globally.
- Do not clear defer on every dispatcher spawn.
- Do not clear defer for cross-agent, fresh-session, or future-scheduled work.
- Do not change objective closeout rules. Objective summaries still require all
  linked tasks to be terminal.
- Do not introduce an objective-specific scheduler path.
- Do not use this hardening slice to extract a central ticker or
  `TaskSchedulerService`. That is a later architecture simplification, not part
  of this repair.

#### Milestone

Milestone: bounded scheduler/task-tool semantic repair.

The milestone owns one production behavior: same-session self-task activation
invalidates stale defer, while all other sticky defer behavior remains intact.

Acceptance:

- Existing dispatcher sticky defer tests continue to pass.
- New task-tool tests prove exactly when defer clear is requested.
- New wiring/integration regression proves a deferred same-session self-task
  clears the stale defer marker through the task tool binding and can then be
  woken by routine `task_in_progress`.
- No API/schema migration is required.

#### Slice 1: Tool-Level Defer Clear Hook

Owner seam:

- `packages/tools/src/builtins/tasks.ts`
- `packages/server/src/agent-manager.ts`
- `packages/db/src/stores/session-store.ts`

Design:

- Extend `TaskStoreBindings` with an optional callback:

```ts
clearSessionDeferUntil?: (event: {
  sessionId: string;
  agentId: string;
  taskId: string;
  taskStatus: "open" | "in_progress";
  source: "task_create" | "task_update";
}) => void;
```

- `AgentManager` wires the callback to
  `this.sessionStore.clearDeferUntil(sessionId)` when binding task tools.
- The `AgentManager` callback may read the prior defer value before clearing.
  Clearing is idempotent; timeline/log output should only claim a stale defer
  was cleared when a previous defer value existed.
- `task_create` and `task_update` call a shared helper after successful store
  mutation.
- Defer clearing is best-effort. A callback failure must not turn an already
  successful task create/update mutation into an `ok:false` tool result.
- The helper clears defer only when all conditions hold:
  - current agent id exists
  - current session id exists
  - task assignee equals current agent id
  - task `session_id` equals current session id
  - task status is active:
    - `in_progress`, regardless of `start_at`, matching dispatcher wake
      semantics
    - `open` with all `depends_on` tasks currently `done` and `start_at`
      absent or not in the future

Dependency readiness must use the current task store state, matching the
dispatcher's eligibility rule. The store no longer persists dependency-waiting
tasks as `blocked`; an `open` task can still be non-actionable if one of its
dependencies is not `done`. `TaskStore.update` already rejects
`in_progress` transitions while dependencies are unsatisfied, so the extra
dependency check matters primarily for newly created or still-`open` tasks.

This keeps the tools package loosely coupled to session storage and avoids
adding a direct `SessionStore` dependency to task tools.

Observability:

- Reuse existing server/session timeline or logger seams from `AgentManager`.
- Record a compact event when a stale defer is cleared by self-task activation,
  for example event type `session.defer.cleared_by_self_task`, with task id,
  session id, agent id, resulting task status, source tool, and prior defer
  value.
- Do not add a new telemetry/exporter layer for this slice.

While touching `packages/tools/src/builtins/tasks.ts`, also align the
`task_create` description and warnings with current dependency behavior:

- replace stale guidance that says unmet `depends_on` force persisted
  `blocked`
- remove or update the now-stale create-time warning that says the task was
  created in `blocked` status because dependencies are not done

TDD:

1. Add failing `task_create` test: self-assigned current-session task calls
   `clearSessionDeferUntil(...)` with session id, agent id, task id, status,
   and source metadata.
2. Add failing `task_create` negative tests:
   - cross-agent task does not clear
   - `session: "fresh"` self-task does not clear
   - explicit other-session task does not clear
   - `open` task with future `start_at` does not clear
   - `open` task with unmet `depends_on` does not clear
3. Add failing `task_update` test: self-assigned current-session task updated
   to `in_progress` calls `clearSessionDeferUntil(...)` with source
   `task_update`.
4. Add failing `task_update` test: self-assigned current-session task made
   `open` and ready in the current session calls `clearSessionDeferUntil(...)`
   with source `task_update`.
5. Add failing best-effort test: if `clearSessionDeferUntil` throws after a
   successful store mutation, the tool still returns `ok:true` and the task
   mutation remains visible.
6. Add failing `task_update` negative tests:
   - `done`, `canceled`, `blocked`, and `system_blocked` do not clear
   - `open` task with future `start_at` does not clear
   - task bound to another session does not clear
7. Implement the helper and callback binding.
8. Update stale task dependency guidance in the same file.
9. Run:

```sh
pnpm --filter @openacme/tools test -- tasks.test.ts
pnpm --filter @openacme/tools check-types
```

#### Slice 2: Dispatcher Semantics Guard

Owner seam:

- `packages/server/src/dispatcher.ts`
- `packages/server/test/dispatcher.test.ts`

Design:

- Dispatcher defer semantics do not need a broad rewrite for this slice.
- Preserve the existing rule:
  - active `defer_until` suppresses routine wakes when `hasInbox=false`
  - targeted inbox bypasses defer
  - defer is not cleared by spawn
- Do not put self-task knowledge into `Dispatcher`; the dispatcher should only
  observe that defer is either present or absent.
- Add only a narrow guard if current coverage does not already prove the
  repaired state: a session that previously had defer, then has defer cleared
  before a current-session `in_progress` task is inspected, is woken by routine
  `task_in_progress`.

TDD:

1. Keep existing test:

```text
defer_until suppresses routine wakes but an inbox row bypasses it
```

2. Add a narrow guard only if not already covered:
   - create session for agent `a1`
   - set defer in the future
   - simulate tool repair by clearing defer after creating or activating a
     self-task bound to the session
   - run dispatcher tick
   - expect `runAutonomous` called with that session
   - expect reason/task timeline shows `task_in_progress`
3. Run:

```sh
pnpm --filter @openacme/server test -- dispatcher.test.ts
pnpm --filter @openacme/server check-types
```

#### Slice 3: Focused Integration Validation

Owner seam:

- Task tools plus dispatcher wiring inside `createApp`/`AgentManager`.

Validation path:

- Use an existing lightweight server/app test only if current coverage does not
  prove callback wiring.
- Avoid live model dependency for CI. The live failure mode is already
  understood from production state and timeline evidence.
- This is the primary regression for the slice because the dispatcher should
  not know why defer was cleared.

Candidate test:

- In a server-level test, bind a task store through `AgentManager`, set a
  session defer, invoke the task tool in current-session context, and assert the
  session store defer is null afterward.
- Cover both:
  - `task_create` self/current/open/ready clears defer
  - `task_update` self/current/in_progress clears defer
- Cover non-actionable dependency state by creating a dependency that is not
  `done`, then creating an `open` dependent task in the same session and
  asserting defer remains set.

Run if implemented:

```sh
pnpm --filter @openacme/server test -- app-routes.test.ts dispatcher.test.ts
pnpm --filter @openacme/server check-types
```

#### Release Validation

Before shipping:

```sh
pnpm --filter @openacme/tools test -- tasks.test.ts
pnpm --filter @openacme/server test -- dispatcher.test.ts
pnpm --filter @openacme/tools check-types
pnpm --filter @openacme/server check-types
```

If the implementation touches shared task binding or app wiring more broadly,
also run:

```sh
pnpm --filter @openacme/server test -- app-routes.test.ts objective-closeout-service.test.ts objective-closeout-watcher.test.ts
```

#### Product Guidance Update

After code behavior is fixed, update task/defer guidance so agents learn the
intended semantics:

- Sticky defer is for suppressing routine idle polling.
- Starting new current-session self-work invalidates old quiet-time intent.
- If the agent creates active work but is intentionally waiting, it should call
  `defer_session(...)` again with a deliberate duration.
- Correct stale task dependency guidance that says unmet dependencies force a
  persisted `blocked` status. Current behavior keeps the task `open` and makes
  readiness a dispatcher/reader eligibility decision until dependencies are
  `done`.

#### Implementation Result: 2026-08-13

Implemented in the `local-stage` worktree without touching local prod.

Code changes:

- `packages/tools/src/builtins/tasks.ts`
  - added best-effort `clearSessionDeferUntil` binding callback metadata
  - clears stale defer after successful `task_create` / `task_update` only for
    current-agent/current-session actionable self-work
  - treats `in_progress` as actionable regardless of `start_at`
  - treats `open` as actionable only when dependencies are `done` and
    `start_at` is ready
  - corrected stale `depends_on` tool guidance
- `packages/server/src/agent-manager.ts`
  - wires the callback to `SessionStore.clearDeferUntil`
  - records `session.defer.cleared_by_self_task` timeline events only when a
    prior defer value existed
- `packages/server/test/task-defer-reset-wiring.test.ts`
  - verifies real app wiring clears persisted defer and records timeline
- `packages/server/test/dispatcher.test.ts`
  - guards that routine `task_in_progress` wake works after defer has been
    externally cleared

TDD evidence:

- Initial `pnpm --filter @openacme/tools test -- tasks.test.ts` failed with 4
  expected callback-related failures before implementation.
- After implementation, focused tests passed:

```sh
pnpm --filter @openacme/tools test -- tasks.test.ts
pnpm --filter @openacme/server test -- task-defer-reset-wiring.test.ts
pnpm --filter @openacme/server test -- dispatcher.test.ts
pnpm --filter @openacme/tools check-types
pnpm --filter @openacme/server check-types
pnpm --filter @openacme/tools build
pnpm --filter @openacme/server build
pnpm --filter @openacme/server test -- app-routes.test.ts objective-closeout-service.test.ts objective-closeout-watcher.test.ts
pnpm --filter @openacme/server test -- objective-closeout-wiring.test.ts
```

## Resolved Design Decisions

### Store Ownership

Decision:

- Concrete `ObjectiveStore` lives in `@openacme/db`.
- Shared objective constants/types may live in `@openacme/tasks`.

### Owner Authority

Decision:

- Objective close/failed/canceled should be allowed for the objective owner agent and system/admin API paths.
- Store remains deterministic; tool/API layer enforces actor rules.

### No-Task Objectives

Decision:

- Allow objectives with zero linked tasks.
- Closeout watcher ignores them.
- Owner can manually close them with `objective_close`.

This supports same-session tracked work where no separate task is needed.

### Canceled Linked Tasks

Decision:

- Closeout watcher treats `canceled` as terminal only for wake purposes.
- Owner decides whether cancellation is acceptable or more work is needed.
