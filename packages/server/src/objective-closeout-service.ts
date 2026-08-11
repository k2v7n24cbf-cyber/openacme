import { createLogger } from "@openacme/config/logger";
import { withOpenAcmeSpan } from "@openacme/llm-provider";
import type {
  InboxStore,
  ObjectiveStore,
  SessionStore,
} from "@openacme/db";
import type {
  ObjectiveCloseoutCheckOptions,
  ObjectiveCloseoutCheckResult,
  ObjectiveCloseoutReady,
  ObjectiveCloseoutWatcher,
} from "./objective-closeout-watcher.js";
import type {
  ObjectiveCloseoutSummarizer,
  ObjectiveCloseoutSummaryResult,
} from "./objective-closeout-summarizer.js";

const log = createLogger("server.objective-closeout-service");

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_OBJECTIVE_LIMIT = 50;
const DEFAULT_CHECK_BUDGET_MS = 100;

export interface ObjectiveCloseoutDispatcher {
  kick(reason?: string): void;
}

export interface ObjectiveCloseoutServiceOptions {
  watcher: Pick<ObjectiveCloseoutWatcher, "check">;
  summarizer?: Pick<ObjectiveCloseoutSummarizer, "summarize"> | null;
  objectiveStore: Pick<
    ObjectiveStore,
    "appendObjectiveEvent" | "recordCloseoutBrief"
  >;
  inboxStore: Pick<InboxStore, "deliver">;
  sessionStore: Pick<SessionStore, "get">;
  dispatcher: ObjectiveCloseoutDispatcher;
  intervalMs?: number;
  objectiveLimit?: number;
  checkBudgetMs?: number;
}

export class ObjectiveCloseoutService {
  private readonly watcher: Pick<ObjectiveCloseoutWatcher, "check">;
  private readonly summarizer:
    | Pick<ObjectiveCloseoutSummarizer, "summarize">
    | null;
  private readonly objectiveStore: ObjectiveCloseoutServiceOptions["objectiveStore"];
  private readonly inboxStore: Pick<InboxStore, "deliver">;
  private readonly sessionStore: Pick<SessionStore, "get">;
  private readonly dispatcher: ObjectiveCloseoutDispatcher;
  private readonly intervalMs: number;
  private readonly objectiveLimit: number;
  private readonly checkBudgetMs: number;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private checkInFlight: Promise<void> | null = null;
  private checkAgain = false;

  constructor(options: ObjectiveCloseoutServiceOptions) {
    this.watcher = options.watcher;
    this.summarizer = options.summarizer ?? null;
    this.objectiveStore = options.objectiveStore;
    this.inboxStore = options.inboxStore;
    this.sessionStore = options.sessionStore;
    this.dispatcher = options.dispatcher;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.objectiveLimit = options.objectiveLimit ?? DEFAULT_OBJECTIVE_LIMIT;
    this.checkBudgetMs = options.checkBudgetMs ?? DEFAULT_CHECK_BUDGET_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.kick("interval"), this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.checkAgain = false;
  }

  kick(reason = "manual"): void {
    if (!this.running) return;
    if (this.checkInFlight) {
      this.checkAgain = true;
      return;
    }
    this.checkInFlight = this.runCheck(reason).finally(() => {
      this.checkInFlight = null;
      if (this.running && this.checkAgain) {
        this.checkAgain = false;
        this.kick("queued");
      }
    });
  }

  async drain(timeoutMs = 5_000): Promise<void> {
    const inFlight = this.checkInFlight;
    if (!inFlight) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => resolve(), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    await Promise.race([inFlight, timeout]);
    if (timer) clearTimeout(timer);
  }

  private async runCheck(reason: string): Promise<void> {
    await withOpenAcmeSpan(
      "objective.closeout.check",
      {
        "objective.closeout.reason": reason,
        "objective.closeout.limit": this.objectiveLimit,
        "objective.closeout.budget_ms": this.checkBudgetMs,
      },
      async (span) => {
        let result: ObjectiveCloseoutCheckResult;
        try {
          const options: ObjectiveCloseoutCheckOptions = {
            limit: this.objectiveLimit,
            budgetMs: this.checkBudgetMs,
          };
          result = await this.watcher.check(options);
        } catch (error) {
          span.recordException(error);
          span.setAttributes({
            "objective.closeout.result": "failed",
          });
          log.warn({ err: error, reason }, "objective closeout check failed");
          return;
        }

        span.setAttributes({
          "objective.closeout.result": "ok",
          "objectives.scanned": result.scanned,
          "objectives.ready": result.ready.length,
        });
        for (const ready of result.ready) {
          if (!this.running) break;
          await this.deliverReady(ready);
        }
      },
    );
  }

  private async deliverReady(ready: ObjectiveCloseoutReady): Promise<void> {
    await withOpenAcmeSpan(
      "objective.closeout.deliver_notice",
      {
        "objective.id": ready.objective.id,
        "objective.status": ready.objective.status,
        "objective.closeout.reason": ready.reason,
        "linked_task_count": ready.packet.rollup.linked_task_count,
        "terminal_task_count": ready.packet.rollup.terminal_task_count,
        "nonterminal_task_count": ready.packet.rollup.nonterminal_task_count,
      },
      async (span) => {
        const summary = await this.summarize(ready);
        span.setAttributes({
          "summary.used": summary.brief !== null,
          "summary.input_truncated": summary.inputTruncated,
          "summary.compression_used": summary.compressionUsed,
          "summary.failure_reason": summary.failureReasons.join(","),
        });
        const relatedSession = this.resolveRelatedSession(ready);
        const linkedTaskIds = ready.packet.linked_tasks.map((task) => task.id);
        try {
          this.inboxStore.deliver({
            agentId: ready.objective.ownerAgentId,
            kind: "system_notice",
            source: "system",
            sourceId: "system:objective-closeout",
            relatedSession,
            payload: {
              eventKind: "objective_ready_for_closeout",
              objectiveId: ready.objective.id,
              linkedTaskIds,
              closeoutPacket: ready.packet,
              closeoutBrief: summary.brief,
              prompt: ready.objective.closeoutPrompt,
            },
          });
        } catch (error) {
          span.recordException(error);
          span.setAttributes({
            "objective.closeout.result": "failed",
            "notice.delivered": false,
            "dispatcher.kicked": false,
          });
          log.warn(
            { err: error, objectiveId: ready.objective.id },
            "objective closeout notice delivery failed",
          );
          return;
        }
        this.appendObjectiveEvent({
          objectiveId: ready.objective.id,
          eventType: "owner_wake_requested",
          actor: "system:objective-closeout",
          summary: "Owner wake requested for objective closeout",
          details: {
            fingerprint: ready.fingerprint,
            relatedSession,
          },
        });
        this.dispatcher.kick("objective_closeout");
        span.setAttributes({
          "objective.closeout.result": "ok",
          "notice.delivered": true,
          "dispatcher.kicked": true,
        });
      },
    );
  }

  private async summarize(
    ready: ObjectiveCloseoutReady,
  ): Promise<ObjectiveCloseoutSummaryResult> {
    if (!this.summarizer) {
      this.appendObjectiveEvent({
        objectiveId: ready.objective.id,
        eventType: "closeout_brief_failed",
        actor: "system:objective-closeout",
        summary: "Closeout brief unavailable",
        details: {
          fingerprint: ready.fingerprint,
          failureReasons: ["summarizer_unavailable"],
        },
      });
      return {
        status: "failed",
        brief: null,
        packedInput: null,
        failureReasons: ["summarizer_unavailable"],
        compressionUsed: false,
        inputTruncated: false,
      };
    }
    try {
      const result = await this.summarizer.summarize(ready.packet);
      this.recordCloseoutBrief(
        ready.objective.id,
        {
          fingerprint: ready.fingerprint,
          packet: ready.packet,
          brief: result.brief,
          summaryStatus: result.status,
          failureReasons: result.failureReasons,
          compressionUsed: result.compressionUsed,
          inputTruncated: result.inputTruncated,
        },
        "system:objective-closeout",
      );
      if (result.status === "failed") {
        this.appendObjectiveEvent({
          objectiveId: ready.objective.id,
          eventType: "closeout_brief_failed",
          actor: "system:objective-closeout",
          summary: "Closeout brief unavailable",
          details: {
            fingerprint: ready.fingerprint,
            failureReasons: result.failureReasons,
          },
        });
      }
      return result;
    } catch (error) {
      const result: ObjectiveCloseoutSummaryResult = {
        status: "failed",
        brief: null,
        packedInput: null,
        failureReasons: ["summarizer_failed"],
        compressionUsed: false,
        inputTruncated: false,
      };
      this.appendObjectiveEvent({
        objectiveId: ready.objective.id,
        eventType: "closeout_brief_failed",
        actor: "system:objective-closeout",
        summary: "Closeout brief unavailable",
        details: {
          fingerprint: ready.fingerprint,
          failureReasons: result.failureReasons,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return result;
    }
  }

  private resolveRelatedSession(ready: ObjectiveCloseoutReady): string | null {
    const ownerSessionId = ready.objective.ownerSessionId;
    if (!ownerSessionId) return null;
    const session = this.sessionStore.get(ownerSessionId);
    if (session && session.agentId === ready.objective.ownerAgentId) {
      return ownerSessionId;
    }
    this.appendObjectiveEvent({
      objectiveId: ready.objective.id,
      eventType: "owner_session_unavailable",
      actor: "system:objective-closeout",
      summary: "Objective owner session unavailable; delivered agent-wide",
      details: {
        ownerSessionId,
      },
    });
    return null;
  }

  private appendObjectiveEvent(
    input: Parameters<ObjectiveStore["appendObjectiveEvent"]>[0],
  ): void {
    try {
      this.objectiveStore.appendObjectiveEvent(input);
    } catch (error) {
      log.warn(
        { err: error, objectiveId: input.objectiveId, eventType: input.eventType },
        "objective closeout ledger event failed",
      );
    }
  }

  private recordCloseoutBrief(
    id: string,
    snapshot: Parameters<ObjectiveStore["recordCloseoutBrief"]>[1],
    actor: string,
  ): void {
    try {
      this.objectiveStore.recordCloseoutBrief(id, snapshot, actor);
    } catch (error) {
      log.warn(
        { err: error, objectiveId: id },
        "objective closeout brief snapshot failed",
      );
    }
  }
}
