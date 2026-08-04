import { describe, expect, it } from "vitest";
import { WorkflowDispatcher, type WorkflowDefinition } from "../src/index.js";

const now = new Date("2026-07-30T02:00:30.000Z");
const scheduledAt = "2026-07-30T02:00:00.000Z";

function definition(
  id: string,
  triggers: WorkflowDefinition["triggers"],
): WorkflowDefinition {
  return {
    id,
    version: 2,
    status: "published",
    name: id,
    triggers,
    nodes: [],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

describe("WorkflowDispatcher", () => {
  it("dispatches due enabled scheduled triggers once per scheduled minute", async () => {
    const executed: string[] = [];
    const dispatcher = new WorkflowDispatcher();

    const result = await dispatcher.dispatchScheduledDue({
      definitions: [
        definition("wf_due", [
          { id: "manual", kind: "manual", enabled: true },
          {
            id: "nightly",
            kind: "scheduled",
            enabled: true,
            schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
          },
          {
            id: "disabled",
            kind: "scheduled",
            enabled: false,
            schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
          },
          {
            id: "existing",
            kind: "scheduled",
            enabled: true,
            schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
          },
        ]),
        definition("wf_not_due", [
          {
            id: "later",
            kind: "scheduled",
            enabled: true,
            schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
          },
        ]),
      ],
      now,
      isDue: (trigger) => trigger.id === "nightly" || trigger.id === "existing",
      alreadyDispatched: ({ trigger }) => trigger.id === "existing",
      execute: async ({ definition, trigger }) => {
        executed.push(`${definition.id}:${trigger.id}`);
        return { runId: "run_1" };
      },
    });

    expect(executed).toEqual(["wf_due:nightly"]);
    expect(result.scheduledAt).toBe(scheduledAt);
    expect(result.dispatched).toEqual([
      {
        workflowId: "wf_due",
        workflowVersion: 2,
        triggerId: "nightly",
        result: { runId: "run_1" },
      },
    ]);
    expect(result.skipped).toEqual([
      {
        workflowId: "wf_due",
        workflowVersion: 2,
        triggerId: "disabled",
        reason: "disabled",
      },
      {
        workflowId: "wf_due",
        workflowVersion: 2,
        triggerId: "existing",
        reason: "already_dispatched",
      },
      {
        workflowId: "wf_not_due",
        workflowVersion: 2,
        triggerId: "later",
        reason: "not_due",
      },
    ]);
  });

  it("records invalid schedule checks without blocking other due triggers", async () => {
    const dispatcher = new WorkflowDispatcher();

    const result = await dispatcher.dispatchScheduledDue({
      definitions: [
        definition("wf_schedule_errors", [
          {
            id: "bad_cron",
            kind: "scheduled",
            enabled: true,
            schedule: { kind: "cron", expr: "not cron", tz: "UTC" },
          },
          {
            id: "good_cron",
            kind: "scheduled",
            enabled: true,
            schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
          },
        ]),
      ],
      now,
      isDue: (trigger) => {
        if (trigger.id === "bad_cron") throw new Error("invalid cron");
        return true;
      },
      alreadyDispatched: () => false,
      execute: async ({ trigger }) => ({ triggerId: trigger.id }),
    });

    expect(result.dispatched).toEqual([
      {
        workflowId: "wf_schedule_errors",
        workflowVersion: 2,
        triggerId: "good_cron",
        result: { triggerId: "good_cron" },
      },
    ]);
    expect(result.skipped).toEqual([
      {
        workflowId: "wf_schedule_errors",
        workflowVersion: 2,
        triggerId: "bad_cron",
        reason: "invalid_schedule",
        error: "invalid cron",
      },
    ]);
  });

  it("records execution failures without blocking other due triggers", async () => {
    const executed: string[] = [];
    const dispatcher = new WorkflowDispatcher();

    const result = await dispatcher.dispatchScheduledDue({
      definitions: [
        definition("wf_execute_errors", [
          {
            id: "bad_input",
            kind: "scheduled",
            enabled: true,
            schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
          },
          {
            id: "good_input",
            kind: "scheduled",
            enabled: true,
            schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
          },
        ]),
      ],
      now,
      isDue: () => true,
      alreadyDispatched: () => false,
      execute: async ({ trigger }) => {
        executed.push(trigger.id);
        if (trigger.id === "bad_input") {
          throw new Error("Input does not match schema");
        }
        return { triggerId: trigger.id };
      },
    });

    expect(executed).toEqual(["bad_input", "good_input"]);
    expect(result.dispatched).toEqual([
      {
        workflowId: "wf_execute_errors",
        workflowVersion: 2,
        triggerId: "good_input",
        result: { triggerId: "good_input" },
      },
    ]);
    expect(result.skipped).toEqual([
      {
        workflowId: "wf_execute_errors",
        workflowVersion: 2,
        triggerId: "bad_input",
        reason: "execution_failed",
        error: "Input does not match schema",
      },
    ]);
  });
});
