import type { WorkflowDefinition, WorkflowTrigger } from "./schemas.js";

export type WorkflowScheduledTrigger = Extract<
  WorkflowTrigger,
  { kind: "scheduled" }
>;

export interface WorkflowScheduledDispatchCandidate {
  definition: WorkflowDefinition;
  trigger: WorkflowScheduledTrigger;
  scheduledAt: string;
}

export interface WorkflowScheduledDispatchOptions<T> {
  definitions: WorkflowDefinition[];
  now?: Date;
  isDue: (
    trigger: WorkflowScheduledTrigger,
    now: Date,
  ) => boolean | Promise<boolean>;
  alreadyDispatched: (
    candidate: WorkflowScheduledDispatchCandidate,
  ) => boolean | Promise<boolean>;
  execute: (candidate: WorkflowScheduledDispatchCandidate) => Promise<T>;
}

export type WorkflowScheduledDispatchSkippedReason =
  | "disabled"
  | "not_due"
  | "already_dispatched"
  | "invalid_schedule"
  | "execution_failed";

export interface WorkflowScheduledDispatchSkipped {
  workflowId: string;
  workflowVersion: number;
  triggerId: string;
  reason: WorkflowScheduledDispatchSkippedReason;
  error?: string;
}

export interface WorkflowScheduledDispatchResult<T> {
  scheduledAt: string;
  scanned: number;
  dispatched: Array<{
    workflowId: string;
    workflowVersion: number;
    triggerId: string;
    result: T;
  }>;
  skipped: WorkflowScheduledDispatchSkipped[];
}

export class WorkflowDispatcher {
  private running = false;

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  async dispatchScheduledDue<T>(
    opts: WorkflowScheduledDispatchOptions<T>,
  ): Promise<WorkflowScheduledDispatchResult<T>> {
    const now = opts.now ?? new Date();
    const scheduledAt = floorMinute(now).toISOString();
    const dispatched: WorkflowScheduledDispatchResult<T>["dispatched"] = [];
    const skipped: WorkflowScheduledDispatchSkipped[] = [];
    let scanned = 0;

    for (const definition of opts.definitions) {
      for (const trigger of definition.triggers) {
        if (trigger.kind !== "scheduled") continue;
        scanned += 1;
        const base = {
          workflowId: definition.id,
          workflowVersion: definition.version,
          triggerId: trigger.id,
        };
        if (!trigger.enabled) {
          skipped.push({ ...base, reason: "disabled" });
          continue;
        }

        let due: boolean;
        try {
          due = await opts.isDue(trigger, now);
        } catch (err) {
          skipped.push({
            ...base,
            reason: "invalid_schedule",
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        if (!due) {
          skipped.push({ ...base, reason: "not_due" });
          continue;
        }

        const candidate = { definition, trigger, scheduledAt };
        if (await opts.alreadyDispatched(candidate)) {
          skipped.push({ ...base, reason: "already_dispatched" });
          continue;
        }

        try {
          dispatched.push({
            ...base,
            result: await opts.execute(candidate),
          });
        } catch (err) {
          skipped.push({
            ...base,
            reason: "execution_failed",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return { scheduledAt, scanned, dispatched, skipped };
  }
}

function floorMinute(value: Date): Date {
  const date = new Date(value);
  date.setUTCSeconds(0, 0);
  return date;
}
