/**
 * Dispatcher — periodic state-checker that wakes agents when there's
 * work to do. Replaces the event-driven `TaskScheduler` with a much
 * smaller state model:
 *
 *   - One `setInterval(60_000)` tick is the autonomous floor.
 *   - Per-agent capacity (`maxConcurrentSessions`, default 1) bounds
 *     how many distinct sessions can run for one canonical agent.
 *   - Spawn rule: capacity free AND no system_blocked task in the session AND
 *     (inbox rows OR in_progress OR ready open OR only-blocked tasks).
 *   - `sessions.defer_until` honoured — skips routine spawns while
 *     active, bypassed by new inbox rows.
 *   - Startup sweep flips stale `in_progress` → `open` (crash recovery
 *     for the daemon-died-mid-turn case).
 *   - `markInteractiveBusy` / `clearInteractiveBusy` preserve the
 *     existing `/api/chat` flow: dispatcher's tick skips sessions
 *     marked busy so autonomous + interactive don't collide.
 *
 * What's gone (vs `TaskScheduler`):
 *   - `onEvent` per-kind routing tree
 *   - debounce / rate-limit / `wakeBySession` map
 *   - watchdog `noClaimStreak`
 *   - heartbeat probes / `probeArmed` cron registry
 *   - `armed` cron registry for `start_at` (tick reads `start_at` ≤ now)
 *   - echo filter (moved to inbox-delivery boundary in AgentManager)
 *   - `wakeRequestedDuringTurn` (capacity pickup handles in-flight
 *     events naturally — they sit in inbox until a slot frees up)
 */

import type { TaskStore, Task } from "@openacme/tasks";
import {
  AutonomousTurnTimeout,
  classifyError,
  extractErrorText,
} from "@openacme/agent-core";
import type {
  SessionStore,
  Session,
  InboxStore,
  SessionTimelineEventInput,
} from "@openacme/db";
import { createLogger } from "@openacme/config/logger";
import type { AgentManager } from "./agent-manager.js";
import type { SessionBroadcaster } from "./broadcaster.js";

const log = createLogger("server.dispatcher");

/** Tick floor. Override in tests for fast iteration. */
const DEFAULT_TICK_MS = 60_000;
/** Park-on-failure backoff. Same value the old TaskScheduler used. */
const PARK_BACKOFF_MS = 5 * 60_000;
/** Expired defer markers are a one-shot self-wake, but only near
 *  their target time. Older rows can exist from previous daemon runs
 *  or older scheduling semantics; replaying all of them on startup
 *  can stampede production with stale autonomous turns. */
const DEFER_EXPIRED_WAKE_GRACE_MS = 5 * 60_000;
const TIMELINE_ERROR_MAX_CHARS = 4096;
type ParallelSchedulingPolicy = "lane_first" | "chain_first";
type DispatcherSpawnReason =
  | "inbox"
  | "task_in_progress"
  | "task_open_ready"
  | "task_blocked_revisit"
  | "defer_expired";

interface SpawnDecision {
  reason: DispatcherSpawnReason;
  taskId: string | null;
  hasInbox: boolean;
}

interface DispatcherRunResult {
  status: "ok" | "error" | "timeout" | "skipped";
  taskId: string | null;
  error?: string;
  reason?: string;
}

function truncateTimelineError(value: string | undefined): string | null {
  if (!value) return null;
  return value.length > TIMELINE_ERROR_MAX_CHARS
    ? value.slice(0, TIMELINE_ERROR_MAX_CHARS)
    : value;
}

export interface DispatcherOptions {
  taskStore: TaskStore;
  sessionStore: SessionStore;
  inboxStore: InboxStore;
  agentManager: AgentManager;
  broadcaster?: SessionBroadcaster;
  onTimelineEvent?: (event: SessionTimelineEventInput) => void;
  /** Override the wall clock — test seam. */
  now?: () => Date;
  /** Override the tick interval. Production is `DEFAULT_TICK_MS`. */
  tickIntervalMs?: number;
}

export class Dispatcher {
  private readonly taskStore: TaskStore;
  private readonly sessionStore: SessionStore;
  private readonly inboxStore: InboxStore;
  private readonly agentManager: AgentManager;
  private readonly broadcaster: SessionBroadcaster | null;
  private readonly onTimelineEvent:
    | ((event: SessionTimelineEventInput) => void)
    | null;
  private readonly now: () => Date;
  private readonly tickIntervalMs: number;

  /** Autonomous turns currently in flight, keyed by session id. */
  private activeTurns = new Map<string, Promise<void>>();
  /** Active autonomous session ids by canonical agent id. */
  private activeByAgent = new Map<string, Set<string>>();
  /** Sessions currently running a turn (autonomous OR interactive).
   *  Powers `runningSessionIds()` for the home view. */
  private runningSessions = new Set<string>();
  /** Sessions with an in-flight interactive `/api/chat` turn. Tick
   *  skips these so autonomous spawn doesn't race the chat reply.
   *  When the interactive turn ends and there's pending inbox work,
   *  the next tick (or the chain free-up if a turn was already
   *  queued) picks it up. */
  private interactiveBusy = new Set<string>();
  /** Track agent ids we've warned about as missing. Without this an
   *  orphan agent (deleted but still referenced) produces a warning
   *  every tick. */
  private missingAgentsLogged = new Set<string>();
  /** True between `start()` and `stop()`. */
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  /** An agent had more eligible work than free slots. Run one pass as
   *  soon as any of that agent's active turns frees a slot. */
  private kickAfterRunAgents = new Set<string>();
  /** Serialize scheduler passes. `kick()` can be called from many inbox/event
   *  paths at once; overlapping ticks would compute capacity from stale
   *  active-session state. */
  private tickInFlight: Promise<void> | null = null;
  private tickAgain = false;
  /** Monotonic in-memory sequence used by `lane_first` scheduling to
   *  prefer sessions that have not yet had a turn in this daemon run. */
  private runSequence = 0;
  private lastRunSequenceBySession = new Map<string, number>();
  private deferSkipKeysBySession = new Map<string, string>();
  private capacityQueuedKeysBySession = new Map<string, string>();
  private blockedSkipKeysBySession = new Map<string, string>();

  constructor(opts: DispatcherOptions) {
    this.taskStore = opts.taskStore;
    this.sessionStore = opts.sessionStore;
    this.inboxStore = opts.inboxStore;
    this.agentManager = opts.agentManager;
    this.broadcaster = opts.broadcaster ?? null;
    this.onTimelineEvent = opts.onTimelineEvent ?? null;
    this.now = opts.now ?? (() => new Date());
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.startupSweep();
    this.timer = setInterval(() => {
      this.tickSafe().catch((e) =>
        log.warn({ err: e }, "dispatcher tick threw"),
      );
    }, this.tickIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.interactiveBusy.clear();
  }

  /**
   * Await any in-flight autonomous turns. Use during graceful shutdown
   * (CLI exit, daemon stop) after `stop()`. Same shape as the old
   * scheduler — bounded by `timeoutMs` so a turn stuck on a slow
   * LLM call doesn't block exit indefinitely.
   */
  async drain(timeoutMs = 5_000): Promise<void> {
    const turns = [...this.activeTurns.values()];
    if (turns.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => resolve(), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    await Promise.race([
      Promise.allSettled(turns).then(() => undefined),
      timeout,
    ]);
    if (timer) clearTimeout(timer);
  }

  /**
   * Sessions currently running a turn — union of autonomous turns in
   * flight (tracked in `runningSessions`) and interactive turns from
   * `/api/chat` (tracked in `interactiveBusy`). Powers the home view's
   * "running" indicator. Without unioning, the home view would miss
   * interactive turns that aren't dispatched by the scheduler.
   */
  runningSessionIds(): string[] {
    const all = new Set<string>(this.runningSessions);
    for (const id of this.interactiveBusy) all.add(id);
    return [...all];
  }

  /**
   * True if EITHER an autonomous turn (tick-spawned) OR an interactive
   * turn (`/api/chat`) is in flight for this session. `/api/chat` reads
   * this to decide whether a new POST should queue to the inbox (so the
   * in-flight turn drains it next) instead of spawning a parallel
   * `runChatTurn` — without the union check, autonomous turns are
   * invisible to the chat route and the two turns race.
   */
  isRunning(sessionId: string): boolean {
    return (
      this.runningSessions.has(sessionId) || this.interactiveBusy.has(sessionId)
    );
  }

  /**
   * True when starting a new turn for this session would respect both
   * same-session serialization and the agent's configured capacity.
   */
  canStartRun(agentId: string, sessionId: string): boolean {
    if (this.isRunning(sessionId)) return false;
    const def = this.agentManager.getAgentDef(agentId);
    if (!def) return false;
    return (
      this.activeSessionIdsForAgent(agentId).size <
      this.maxConcurrentSessions(def)
    );
  }

  /**
   * `/api/chat` calls this when it starts driving a turn directly
   * (via `runChatTurn`). The dispatcher's tick skips sessions in
   * this set so we don't try to spawn an autonomous turn into the
   * same session the chat handler is already streaming through.
   */
  markInteractiveBusy(sessionId: string): void {
    this.interactiveBusy.add(sessionId);
  }

  clearInteractiveBusy(sessionId: string): void {
    if (!this.interactiveBusy.delete(sessionId)) return;
    // The chat turn just ended — if there's pending inbox work for this
    // session's agent, kick a tick immediately so the agent picks it up
    // without waiting up to 60 s for the periodic tick.
    if (!this.running) return;
    this.tickSafe().catch((e) =>
      log.warn({ err: e, sessionId }, "post-interactive tick threw"),
    );
  }

  /** Run one scheduler pass soon without waiting for the 60s floor.
   *  Used after server-side completion signals land in the inbox. */
  kick(reason = "manual"): void {
    if (!this.running) return;
    for (const agentId of this.activeByAgent.keys()) {
      this.kickAfterRunAgents.add(agentId);
    }
    this.tickSafe().catch((e) =>
      log.warn({ err: e, reason }, "dispatcher kick threw"),
    );
  }

  private recordTimeline(input: SessionTimelineEventInput): void {
    if (!this.onTimelineEvent) return;
    try {
      this.onTimelineEvent(input);
    } catch (e) {
      log.warn(
        { err: e, sessionId: input.sessionId, eventType: input.eventType },
        "dispatcher timeline event failed",
      );
    }
  }

  private recordDeferSkipped(
    agentId: string,
    sessionId: string,
    decision: SpawnDecision,
    facts: { deferUntilMs: number },
  ): void {
    const key = [
      facts.deferUntilMs,
      decision.reason,
      decision.taskId ?? "",
    ].join(":");
    if (this.deferSkipKeysBySession.get(sessionId) === key) return;
    this.deferSkipKeysBySession.set(sessionId, key);
    this.recordTimeline({
      sessionId,
      agentId,
      taskId: decision.taskId,
      eventType: "session.dispatcher.defer.skipped",
      source: "dispatcher",
      status: "skipped",
      payload: {
        reason: decision.reason,
        hasInbox: decision.hasInbox,
        deferUntilMs: facts.deferUntilMs,
      },
    });
  }

  private recordCapacityQueued(
    agentId: string,
    sessionId: string,
    decision: SpawnDecision,
    facts: { limit: number; activeCount: number },
  ): void {
    const key = [
      facts.limit,
      facts.activeCount,
      decision.reason,
      decision.taskId ?? "",
    ].join(":");
    if (this.capacityQueuedKeysBySession.get(sessionId) === key) return;
    this.capacityQueuedKeysBySession.set(sessionId, key);
    this.recordTimeline({
      sessionId,
      agentId,
      taskId: decision.taskId,
      eventType: "session.dispatcher.capacity_queued",
      source: "dispatcher",
      status: "queued",
      payload: {
        reason: decision.reason,
        hasInbox: decision.hasInbox,
        limit: facts.limit,
        activeCount: facts.activeCount,
      },
    });
  }

  private recordBlockedSkipped(
    agentId: string,
    sessionId: string,
    decision: SpawnDecision,
    facts: { blockReason: string; blockSource: "session" | "task" },
  ): void {
    const key = [
      facts.blockSource,
      facts.blockReason,
      decision.reason,
      decision.taskId ?? "",
      decision.hasInbox ? "inbox" : "routine",
    ].join(":");
    if (this.blockedSkipKeysBySession.get(sessionId) === key) return;
    this.blockedSkipKeysBySession.set(sessionId, key);
    log.info(
      {
        agentId,
        sessionId,
        taskId: decision.taskId,
        blockReason: facts.blockReason,
        blockSource: facts.blockSource,
        reason: decision.reason,
        hasInbox: decision.hasInbox,
      },
      "dispatcher skipped blocked session wake",
    );
    this.recordTimeline({
      sessionId,
      agentId,
      taskId: decision.taskId,
      eventType: "session.dispatcher.blocked.skipped",
      source: "dispatcher",
      status: "skipped",
      payload: {
        reason: decision.reason,
        hasInbox: decision.hasInbox,
        blockReason: facts.blockReason,
        blockSource: facts.blockSource,
      },
    });
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async tickSafe(): Promise<void> {
    if (!this.running) return;
    if (this.tickInFlight) {
      this.tickAgain = true;
      await this.tickInFlight;
      return;
    }

    const run = this.drainTickQueue();
    this.tickInFlight = run;
    try {
      await run;
    } finally {
      if (this.tickInFlight === run) {
        this.tickInFlight = null;
      }
    }
  }

  private async drainTickQueue(): Promise<void> {
    do {
      this.tickAgain = false;
      if (!this.running) return;
      try {
        await this.tick();
      } catch (e) {
        log.warn({ err: e }, "dispatcher tick failed");
      }
    } while (this.running && this.tickAgain);
  }

  private maxConcurrentSessions(agentDef: unknown): number {
    const raw = (agentDef as { maxConcurrentSessions?: unknown })
      .maxConcurrentSessions;
    return typeof raw === "number" && Number.isFinite(raw)
      ? Math.max(1, Math.min(5, Math.trunc(raw)))
      : 1;
  }

  private parallelSchedulingPolicy(
    agentDef: unknown,
  ): ParallelSchedulingPolicy {
    const raw = (agentDef as { parallelSchedulingPolicy?: unknown })
      .parallelSchedulingPolicy;
    return raw === "chain_first" ? "chain_first" : "lane_first";
  }

  private activeSessionIdsForAgent(agentId: string): Set<string> {
    const ids = new Set(this.activeByAgent.get(agentId) ?? []);
    for (const sessionId of this.interactiveBusy) {
      const session = this.sessionStore.get(sessionId);
      if (session?.agentId === agentId) ids.add(sessionId);
    }
    return ids;
  }

  /**
   * One pass over the board. Walks every agent; for each agent whose
   * capacity has room, finds sessions that have work and spawns turns
   * up to the configured limit. State-checking only — no event routing,
   * no debounce.
   */
  private async tick(): Promise<void> {
    const agents = this.agentManager.listAgents();
    const nowMs = this.now().getTime();

    for (const agentDef of agents) {
      const agentId = agentDef.id;
      const limit = this.maxConcurrentSessions(agentDef);
      const schedulingPolicy = this.parallelSchedulingPolicy(agentDef);
      let available = limit - this.activeSessionIdsForAgent(agentId).size;

      // First, allocate sessions for any unbound ready tasks assigned
      // to this agent. The old scheduler did this on every relevant
      // event; the dispatcher does it on every tick because the
      // alternative — unbound tasks invisibly accumulating — would
      // mean the spawn loop below (per-session) never sees them.
      await this.bindUnboundTasks(agentId, nowMs);

      const pending = this.inboxStore.pendingSummaryFor(agentId);

      // If the inbox has rows pointing at a specific session, prefer
      // that session as the spawn target. user_message rows always
      // carry relatedSession. Human-authored task comments are a second
      // priority tier: they are user attention, but direct chat/prompt
      // messages still win when both arrive together.
      const targetedSessions = pending.targetedSessionIds;
      const userMessageSessions = pending.userMessageSessionIds;
      const userTaskCommentSessions = pending.userTaskCommentSessionIds;

      const sessions = this.sessionStore.listActive(agentId);
      const ordered = this.orderSessionsForScheduling(sessions, {
        policy: schedulingPolicy,
        targetedSessions,
        userMessageSessions,
        userTaskCommentSessions,
      });
      let agentWideAssigned = false;

      for (const session of ordered) {
        if (this.runningSessions.has(session.id)) continue;
        if (this.interactiveBusy.has(session.id)) continue;

        const hasTargetedInbox = targetedSessions.has(session.id);
        const hasDirectUserInbox = userMessageSessions.has(session.id);
        const hasAgentWideInbox = pending.hasAgentWide && !agentWideAssigned;
        const hasInbox = hasTargetedInbox || hasAgentWideInbox;

        const blockedWake = this.blockedWakeDecision(session, nowMs, {
          hasInbox,
          hasDirectUserInbox,
        });
        if (blockedWake) {
          this.recordBlockedSkipped(agentId, session.id, blockedWake.decision, {
            blockReason: blockedWake.blockReason,
            blockSource: blockedWake.blockSource,
          });
          continue;
        }

        // Defer check — skip routine spawns until `defer_until`.
        // New inbox rows bypass: defer is "no routine checks," not
        // "ignore real signals."
        if (
          session.deferUntil != null &&
          session.deferUntil * 1000 > nowMs &&
          !hasInbox
        ) {
          const deferredDecision = this.spawnDecision(session, nowMs, {
            hasInbox: false,
            hasDirectUserInbox: false,
          });
          if (deferredDecision) {
            this.recordDeferSkipped(agentId, session.id, deferredDecision, {
              deferUntilMs: session.deferUntil * 1000,
            });
          }
          continue;
        }

        const decision = this.spawnDecision(session, nowMs, {
          hasInbox,
          hasDirectUserInbox,
        });
        if (decision) {
          if (available <= 0) {
            if (limit > 1 || hasInbox) {
              this.kickAfterRunAgents.add(agentId);
            }
            this.recordCapacityQueued(agentId, session.id, decision, {
              limit,
              activeCount: this.activeSessionIdsForAgent(agentId).size,
            });
            break;
          }
          if (this.enqueueTurn(agentId, session.id, decision)) {
            this.blockedSkipKeysBySession.delete(session.id);
            available--;
            if (pending.hasAgentWide) agentWideAssigned = true;
          }
        } else {
          this.deferSkipKeysBySession.delete(session.id);
          this.blockedSkipKeysBySession.delete(session.id);
        }
      }
    }
  }

  private blockedWakeDecision(
    session: Session,
    nowMs: number,
    inbox: { hasInbox: boolean; hasDirectUserInbox: boolean },
  ): {
    decision: SpawnDecision;
    blockReason: string;
    blockSource: "session" | "task";
  } | null {
    const tasks = this.taskStore.list({ session_id: session.id });
    const systemBlockedTask = tasks.find((t) => t.status === "system_blocked");
    if (!session.turnsBlockedReason && !systemBlockedTask) return null;
    const taskId = this.timelineTaskFromTasks(tasks, nowMs)?.id ?? null;
    const sessionKind = tasks.length > 0 ? "task" : session.kind;

    if (inbox.hasInbox) {
      return {
        decision: { reason: "inbox", taskId, hasInbox: true },
        blockReason:
          session.turnsBlockedReason ??
          (systemBlockedTask ? "task_system_blocked" : "blocked"),
        blockSource: session.turnsBlockedReason ? "session" : "task",
      };
    }
    if (!session.turnsBlockedReason || sessionKind === "chat") return null;

    const routineDecision = this.routineTaskDecisionFromTasks(
      tasks,
      nowMs,
      false,
    );
    if (!routineDecision) return null;
    return {
      decision: routineDecision,
      blockReason: session.turnsBlockedReason,
      blockSource: "session",
    };
  }

  private orderSessionsForScheduling(
    sessions: ReturnType<SessionStore["listActive"]>,
    opts: {
      policy: ParallelSchedulingPolicy;
      targetedSessions: Set<string>;
      userMessageSessions: Set<string>;
      userTaskCommentSessions: Set<string>;
    },
  ): ReturnType<SessionStore["listActive"]> {
    const indexed = sessions.map((session, index) => ({ session, index }));
    indexed.sort((a, b) => {
      // Direct human/user traffic always wins over every autonomous
      // task-chain policy and over task-comment wakes.
      const aUser = opts.userMessageSessions.has(a.session.id) ? 1 : 0;
      const bUser = opts.userMessageSessions.has(b.session.id) ? 1 : 0;
      if (aUser !== bUser) return bUser - aUser;

      // Human task comments are user attention too, but can wait behind
      // direct prompt/chat messages.
      const aComment = opts.userTaskCommentSessions.has(a.session.id) ? 1 : 0;
      const bComment = opts.userTaskCommentSessions.has(b.session.id) ? 1 : 0;
      if (aComment !== bComment) return bComment - aComment;

      if (opts.policy === "lane_first") {
        const aLast = this.lastRunSequenceBySession.get(a.session.id) ?? 0;
        const bLast = this.lastRunSequenceBySession.get(b.session.id) ?? 0;
        if (aLast !== bLast) return aLast - bLast;
      } else {
        const aTargeted = opts.targetedSessions.has(a.session.id) ? 1 : 0;
        const bTargeted = opts.targetedSessions.has(b.session.id) ? 1 : 0;
        if (aTargeted !== bTargeted) return bTargeted - aTargeted;
      }

      // Preserve the store's recency order for ties.
      return a.index - b.index;
    });
    return indexed.map(({ session }) => session);
  }

  /**
   * Walk this agent's tasks; for any that are status=open + deps
   * satisfied + start_at clear AND have no session bound, create a
   * fresh session and bind it. Subsequent spawn-decision logic only
   * walks sessions, so without this step unbound tasks would sit
   * invisibly forever.
   */
  private async bindUnboundTasks(
    agentId: string,
    nowMs: number,
  ): Promise<void> {
    const tasks = this.taskStore.list({ assignee: agentId });
    for (const t of tasks) {
      if (t.session_id) {
        if (this.sessionStore.get(t.session_id)) continue;
        try {
          await this.taskStore.update(t.id, { session_id: null });
        } catch (e) {
          log.warn(
            { err: e, taskId: t.id, sessionId: t.session_id, agentId },
            "bindUnboundTasks: failed to clear dangling session binding",
          );
          continue;
        }
      }
      if (t.status !== "open") continue;
      if (!isStartReady(t.start_at, nowMs)) continue;
      if (!this.depsSatisfied(t)) continue;
      try {
        const session = this.sessionStore.create(agentId, {
          title: t.title.slice(0, 80),
          kind: "task",
        });
        await this.taskStore.update(t.id, { session_id: session.id });
      } catch (e) {
        log.warn(
          { err: e, taskId: t.id, agentId },
          "bindUnboundTasks: failed to allocate session",
        );
      }
    }
  }

  /**
   * Spawn rule. Returns the reason the dispatcher should run a turn for
   * this (agent, session) right now.
   *
   * Triggers:
   *   - Pending inbox rows (a signal arrived addressed to this agent).
   *   - An `in_progress` task in this session (continuation — agent
   *     should keep working or close out).
   *   - A ready `open` task assigned to this agent and bound to this
   *     session (status = open, deps satisfied, start_at clear).
   *   - Only `blocked` tasks remain for this session — wake to let
   *     the agent revisit / unblock / defer.
   *
   * "Open task with no session_id yet" is handled at create time —
   * the agent claims a task by setting in_progress + session_id, so
   * unbound tasks aren't a dispatcher concern.
   */
  private spawnDecision(
    session: Session,
    nowMs: number,
    inbox: { hasInbox: boolean; hasDirectUserInbox: boolean },
  ): SpawnDecision | null {
    const sessionId = session.id;
    const tasks = this.taskStore.list({ session_id: sessionId });
    if (session.turnsBlockedReason) {
      return null;
    }
    const sessionKind = tasks.length > 0 ? "task" : session.kind;
    const deferUntilMs =
      session.deferUntil == null ? null : session.deferUntil * 1000;
    const deferExpiredRecently =
      deferUntilMs != null &&
      deferUntilMs <= nowMs &&
      nowMs - deferUntilMs <= DEFER_EXPIRED_WAKE_GRACE_MS;
    if (tasks.some((t) => t.status === "system_blocked")) {
      return null;
    }
    if (sessionKind === "chat" && !inbox.hasInbox && !deferExpiredRecently) {
      return null;
    }
    if (inbox.hasInbox) {
      return {
        reason: "inbox",
        taskId: this.timelineTaskForSession(sessionId, nowMs)?.id ?? null,
        hasInbox: inbox.hasInbox,
      };
    }
    let readyTask: Task | null = null;
    let blockedTask: Task | null = null;
    for (const t of tasks) {
      if (t.status === "in_progress") {
        // Recurring task that fired recently: respect its interval as a
        // wake floor. Without this, an agent that leaves the recurring
        // task in_progress between fires (common pattern for tick-style
        // tasks where the agent appends progress comments instead of
        // calling task_update(done) each cycle) gets re-woken every 60s
        // — ~30 wasted LLM calls per intended 30-min interval. Real
        // signals (inbox row, cross-agent comment) still bypass: that's
        // handled above by `hasInbox`.
        if (t.recurrence?.kind === "interval" && t.last_run_at != null) {
          const lastMs = Date.parse(t.last_run_at);
          if (
            Number.isFinite(lastMs) &&
            lastMs + t.recurrence.every_ms > nowMs
          ) {
            continue;
          }
        }
        return {
          reason: "task_in_progress",
          taskId: t.id,
          hasInbox: inbox.hasInbox,
        };
      }
      if (
        t.status === "open" &&
        isStartReady(t.start_at, nowMs) &&
        this.depsSatisfied(t)
      ) {
        readyTask ??= t;
      } else if (t.status === "blocked") {
        blockedTask ??= t;
      }
    }
    // Returning true on "only blocked tasks" means the dispatcher
    // periodically nudges the agent to revisit. The agent can call
    // `defer_session(duration)` to suppress this if it doesn't want
    // to be checked back so often.
    if (readyTask) {
      return {
        reason: "task_open_ready",
        taskId: readyTask.id,
        hasInbox: inbox.hasInbox,
      };
    }
    if (blockedTask) {
      return {
        reason: "task_blocked_revisit",
        taskId: blockedTask.id,
        hasInbox: inbox.hasInbox,
      };
    }
    if (deferExpiredRecently) {
      return {
        reason: "defer_expired",
        taskId: null,
        hasInbox: inbox.hasInbox,
      };
    }
    return null;
  }

  private timelineTaskForSession(
    sessionId: string,
    nowMs: number,
  ): Task | null {
    const tasks = this.taskStore.list({ session_id: sessionId });
    return this.timelineTaskFromTasks(tasks, nowMs);
  }

  private timelineTaskFromTasks(tasks: Task[], nowMs: number): Task | null {
    return (
      tasks.find((t) => t.status === "in_progress") ??
      tasks.find(
        (t) =>
          t.status === "open" &&
          isStartReady(t.start_at, nowMs) &&
          this.depsSatisfied(t),
      ) ??
      tasks.find((t) => t.status === "blocked") ??
      tasks[0] ??
      null
    );
  }

  private routineTaskDecisionFromTasks(
    tasks: Task[],
    nowMs: number,
    hasInbox: boolean,
  ): SpawnDecision | null {
    let readyTask: Task | null = null;
    let blockedTask: Task | null = null;
    for (const t of tasks) {
      if (t.status === "in_progress") {
        if (t.recurrence?.kind === "interval" && t.last_run_at != null) {
          const lastMs = Date.parse(t.last_run_at);
          if (
            Number.isFinite(lastMs) &&
            lastMs + t.recurrence.every_ms > nowMs
          ) {
            continue;
          }
        }
        return {
          reason: "task_in_progress",
          taskId: t.id,
          hasInbox,
        };
      }
      if (
        t.status === "open" &&
        isStartReady(t.start_at, nowMs) &&
        this.depsSatisfied(t)
      ) {
        readyTask ??= t;
      } else if (t.status === "blocked") {
        blockedTask ??= t;
      }
    }
    if (readyTask) {
      return {
        reason: "task_open_ready",
        taskId: readyTask.id,
        hasInbox,
      };
    }
    if (blockedTask) {
      return {
        reason: "task_blocked_revisit",
        taskId: blockedTask.id,
        hasInbox,
      };
    }
    return null;
  }

  private depsSatisfied(t: Task): boolean {
    if (t.depends_on.length === 0) return true;
    return t.depends_on.every((dep) => {
      const d = this.taskStore.get(dep);
      return d?.status === "done";
    });
  }

  /**
   * Append a turn to the agent's serial chain. Marks the session running,
   * broadcasts state, runs the turn, then cleans up in the finally block.
   *
   * Defer is now sticky — we do NOT clear `defer_until` on spawn. The
   * previous one-shot behavior caused this: a defer of 2h would hold for
   * a while, then the first real signal (inbox row, post-interactive
   * tick) would legitimately wake the agent AND wipe defer; from that
   * point on every periodic 60s tick would re-spawn because nothing
   * suppressed it (any in-progress task triggers the spawn rule). With
   * defer sticky, the same first signal still wakes the agent, but
   * defer stays in place and holds against subsequent pure-tick wakes
   * for the rest of the window. Only an explicit `defer_session` call
   * (or natural expiry) changes it.
   */
  private enqueueTurn(
    agentId: string,
    sessionId: string,
    decision: SpawnDecision,
  ): boolean {
    if (this.runningSessions.has(sessionId)) return false;
    if (this.interactiveBusy.has(sessionId)) return false;
    if (!this.agentExists(agentId)) {
      if (!this.missingAgentsLogged.has(agentId)) {
        this.missingAgentsLogged.add(agentId);
        log.warn(
          { agentId },
          "agent referenced by sessions/tasks but no longer exists — wakes skipped",
        );
      }
      return false;
    }

    this.runningSessions.add(sessionId);
    this.capacityQueuedKeysBySession.delete(sessionId);
    this.lastRunSequenceBySession.set(sessionId, ++this.runSequence);
    let active = this.activeByAgent.get(agentId);
    if (!active) {
      active = new Set<string>();
      this.activeByAgent.set(agentId, active);
    }
    active.add(sessionId);
    if (decision.reason === "defer_expired") {
      this.sessionStore.clearDeferUntil(sessionId);
      this.deferSkipKeysBySession.delete(sessionId);
    }
    if (this.broadcaster) {
      this.broadcaster.broadcast(sessionId, {
        kind: "session_state",
        state: "running",
      });
    }

    const wakeStartedAt = Date.now();
    this.recordTimeline({
      sessionId,
      agentId,
      taskId: decision.taskId,
      eventType: "session.dispatcher.wake.started",
      source: "dispatcher",
      status: "running",
      payload: {
        reason: decision.reason,
        hasInbox: decision.hasInbox,
      },
    });

    const promise = this.runTurn(agentId, sessionId, decision)
      .then((result) => {
        const ok = result.status === "ok";
        this.recordTimeline({
          sessionId,
          agentId,
          taskId: result.taskId ?? decision.taskId,
          eventType: ok
            ? "session.dispatcher.wake.finished"
            : "session.dispatcher.wake.failed",
          source: "dispatcher",
          status:
            result.status === "ok"
              ? "ok"
              : result.status === "timeout"
                ? "timeout"
                : "error",
          durationMs: Date.now() - wakeStartedAt,
          payload: {
            reason: decision.reason,
            resultStatus: result.status,
            error: truncateTimelineError(result.error),
          },
        });
      })
      .finally(() => {
        this.activeTurns.delete(sessionId);
        this.runningSessions.delete(sessionId);
        const activeForAgent = this.activeByAgent.get(agentId);
        activeForAgent?.delete(sessionId);
        if (activeForAgent?.size === 0) this.activeByAgent.delete(agentId);
        if (this.broadcaster) {
          this.broadcaster.broadcast(sessionId, {
            kind: "session_state",
            state: "idle",
          });
        }
        if (this.kickAfterRunAgents.delete(agentId)) {
          this.tickSafe().catch((e) =>
            log.warn({ err: e, sessionId }, "post-run dispatcher kick threw"),
          );
        }
      });
    this.activeTurns.set(sessionId, promise);
    return true;
  }

  private async runTurn(
    agentId: string,
    sessionId: string,
    decision: SpawnDecision,
  ): Promise<DispatcherRunResult> {
    if (!this.running) {
      return {
        status: "skipped",
        taskId: decision.taskId,
        reason: "dispatcher_stopped",
      };
    }
    let agent;
    let refresh;
    try {
      refresh = this.agentManager.getAgentCatalogRefresh(agentId);
      agent = refresh.agent;
    } catch (e) {
      const message = extractErrorText(e);
      log.warn(
        { agentId, sessionId, err: e },
        "agent not available for session",
      );
      this.recordTimeline({
        sessionId,
        agentId,
        taskId: decision.taskId,
        eventType: "session.autonomous.failed",
        source: "dispatcher",
        status: "error",
        payload: {
          reason: decision.reason,
          phase: "agent_lookup",
          error: truncateTimelineError(message),
        },
      });
      return {
        status: "error",
        taskId: decision.taskId,
        error: message,
      };
    }

    const startedAt = Date.now();
    const taskId =
      this.timelineTaskForSession(sessionId, this.now().getTime())?.id ??
      decision.taskId;
    this.agentManager.recordToolCatalogNotice({
      sessionId,
      agentId,
      taskId,
      refresh,
    });
    this.recordTimeline({
      sessionId,
      agentId,
      taskId,
      eventType: "session.autonomous.started",
      source: "dispatcher",
      status: "running",
      payload: {
        reason: decision.reason,
        hasInbox: decision.hasInbox,
      },
    });

    try {
      await agent.runAutonomous({ sessionId });
      this.recordTimeline({
        sessionId,
        agentId,
        taskId,
        eventType: "session.autonomous.finished",
        source: "dispatcher",
        status: "ok",
        durationMs: Date.now() - startedAt,
        payload: {
          reason: decision.reason,
        },
      });
      return { status: "ok", taskId };
    } catch (e) {
      const message = extractErrorText(e);
      const isTimeout = e instanceof AutonomousTurnTimeout;
      if (!isTimeout) {
        log.warn({ sessionId, message }, "autonomous turn failed");
      }
      const classification = classifyError(e);
      if (classification.systemBlockReason) {
        await this.systemBlockInProgress(sessionId, {
          reason: classification.systemBlockReason,
          message,
        });
      } else {
        await this.parkInProgress(sessionId, {
          action: isTimeout ? "timeout" : "error",
          message: isTimeout
            ? `turn timed out at ${this.now().toISOString()}`
            : `turn errored at ${this.now().toISOString()}: ${message}`,
        });
      }
      this.recordTimeline({
        sessionId,
        agentId,
        taskId,
        eventType: "session.autonomous.failed",
        source: "dispatcher",
        status: isTimeout ? "timeout" : "error",
        durationMs: Date.now() - startedAt,
        payload: {
          reason: decision.reason,
          error: truncateTimelineError(message),
        },
      });
      return {
        status: isTimeout ? "timeout" : "error",
        taskId,
        error: message,
      };
    }
  }

  /**
   * After a failed turn, find any task the agent had marked
   * `in_progress` in this session and park it with `start_at = now
   * + PARK_BACKOFF_MS` and a `system:scheduler` comment explaining
   * the failure. Same shape as the old scheduler's `parkInProgress`.
   * If the agent never claimed anything, there's nothing to park —
   * the next tick will retry the same condition.
   */
  private async parkInProgress(
    sessionId: string,
    note: { action: "timeout" | "error"; message: string },
  ): Promise<void> {
    if (
      this.taskStore
        .list({ session_id: sessionId })
        .some((task) => task.status === "system_blocked")
    ) {
      return;
    }
    const inProg = this.taskStore.list({
      session_id: sessionId,
      status: "in_progress",
    });
    const retryAt = new Date(this.now().getTime() + PARK_BACKOFF_MS);
    for (const task of inProg) {
      try {
        if (this.taskStore.get(task.id)?.status !== "in_progress") {
          continue;
        }
        await this.taskStore.park({
          id: task.id,
          retryAt,
          reason: `[${note.action}] ${note.message}`,
        });
      } catch (e) {
        log.warn({ err: e, taskId: task.id }, "parkInProgress failed");
      }
    }
  }

  /**
   * Stop retrying a task when the provider says the request cannot fit the
   * model context. The session binding is preserved for debugging, but the
   * dispatcher will not wake the session again until the status is changed.
   */
  async systemBlockInProgress(
    sessionId: string,
    note: { reason: string; message: string },
  ): Promise<void> {
    this.sessionStore.blockTurns(sessionId, note.reason);
    const session = this.sessionStore.get(sessionId);
    const inProg = this.taskStore.list({
      session_id: sessionId,
      status: "in_progress",
    });
    const taskIds = inProg.map((task) => task.id);
    log.warn(
      {
        sessionId,
        agentId: session?.agentId,
        reason: note.reason,
        taskIds,
      },
      "session turns blocked",
    );
    this.recordTimeline({
      sessionId,
      agentId: session?.agentId ?? "unknown",
      taskId: taskIds[0] ?? null,
      eventType: "session.turn_blocked",
      source: "dispatcher",
      status: "blocked",
      payload: {
        reason: note.reason,
        message: truncateTimelineError(note.message),
        taskIds,
      },
    });
    for (const task of inProg) {
      try {
        await this.taskStore.update(
          task.id,
          { status: "system_blocked", start_at: null },
          { actor: "system:scheduler" },
        );
        await this.taskStore.addComment({
          taskId: task.id,
          author: "system:scheduler",
          kind: "system",
          body: `[system_blocked:${note.reason}] ${note.message}`,
        });
      } catch (e) {
        log.warn({ err: e, taskId: task.id }, "systemBlockInProgress failed");
      }
    }
  }

  /**
   * Startup pass. Runs once at `start()`:
   *   - Flip stale `in_progress` tasks back to `open` (covers the
   *     daemon-died-mid-turn case — the agent process is gone, so
   *     by definition no in-flight turn exists right now).
   *   - Trigger one tick so any pending work is picked up
   *     immediately rather than waiting up to `tickIntervalMs`.
   */
  private async startupSweep(): Promise<void> {
    try {
      const reset = await this.taskStore.sweepStale(this.now());
      if (reset.length > 0) {
        log.info(
          { count: reset.length },
          "reset stale in-progress tasks on startup",
        );
      }
    } catch (e) {
      log.warn({ err: e }, "startup sweep failed");
    }
    await this.tickSafe();
  }

  private agentExists(agentId: string): boolean {
    try {
      return this.agentManager.getAgentDef(agentId) !== null;
    } catch {
      return false;
    }
  }
}

/**
 * Returns true if a task's `start_at` is null or has already passed.
 * Malformed timestamps fall through as "ready now" — same lenient
 * behaviour as the old scheduler's `isFutureStart`.
 */
function isStartReady(startAt: string | null, nowMs: number): boolean {
  if (!startAt) return true;
  const t = Date.parse(startAt);
  if (!Number.isFinite(t)) return true;
  return t <= nowMs;
}
