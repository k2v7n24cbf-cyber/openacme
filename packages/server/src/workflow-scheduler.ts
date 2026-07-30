import { Cron } from "croner";
import type { WorkflowStore } from "@openacme/db";
import type {
  JsonValue,
  WorkflowExecutionPorts,
  WorkflowManager,
  WorkflowScheduledDispatchResult,
  WorkflowScheduledTrigger,
} from "@openacme/workflows";
import { executePublishedTriggerRun } from "./routes/workflows.js";

export interface DispatchDueScheduledWorkflowTriggersOptions {
  now?: Date;
  ports?: WorkflowExecutionPorts;
  input?: JsonValue;
  limit?: number;
}

export type ScheduledWorkflowDispatchRunResult = Awaited<
  ReturnType<typeof executePublishedTriggerRun>
>;

export async function dispatchDueScheduledWorkflowTriggers(
  store: WorkflowStore,
  manager: WorkflowManager,
  opts: DispatchDueScheduledWorkflowTriggersOptions = {},
): Promise<
  WorkflowScheduledDispatchResult<ScheduledWorkflowDispatchRunResult>
> {
  const definitions = store
    .listDefinitions({ status: "published", limit: opts.limit ?? 500 })
    .map((definition) => store.getVersion(definition.id, definition.version))
    .filter((definition) => definition !== null);

  return manager.dispatchScheduledDue({
    definitions,
    now: opts.now,
    isDue: isScheduledTriggerDue,
    alreadyDispatched: (candidate) => hasScheduledDispatchRun(store, candidate),
    execute: (candidate) =>
      executePublishedTriggerRun(store, {
        definition: candidate.definition,
        trigger: candidate.trigger,
        input: candidate.trigger.input ?? opts.input ?? {},
        scheduledAt: candidate.scheduledAt,
        ports: opts.ports,
      }),
  });
}

export function isScheduledTriggerDue(
  trigger: WorkflowScheduledTrigger,
  now: Date,
): boolean {
  const dueAt = floorMinute(now);
  const job = new Cron(trigger.schedule.expr, {
    paused: true,
    mode: "5-part",
    ...(trigger.schedule.tz ? { timezone: trigger.schedule.tz } : {}),
  });
  return job.match(dueAt);
}

function hasScheduledDispatchRun(
  store: WorkflowStore,
  candidate: {
    definition: { id: string; version: number };
    trigger: { id: string };
    scheduledAt: string;
  },
): boolean {
  return store
    .listRuns({
      workflowId: candidate.definition.id,
      mode: "live",
      triggerId: candidate.trigger.id,
      limit: 500,
    })
    .some(
      (run) =>
        run.definitionSource === "published" &&
        run.workflowVersion === candidate.definition.version &&
        run.trigger.kind === "scheduled" &&
        run.trigger.scheduledAt === candidate.scheduledAt,
    );
}

function floorMinute(value: Date): Date {
  const date = new Date(value);
  date.setUTCSeconds(0, 0);
  return date;
}
