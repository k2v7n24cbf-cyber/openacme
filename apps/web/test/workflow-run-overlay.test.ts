import { describe, expect, it } from "vitest";
import { buildWorkflowGraphProjection } from "@/app/workflows/graph";
import {
  applyWorkflowRunOverlay,
  latestWorkflowRunStepIdForNode,
} from "@/app/workflows/run-overlay";

describe("applyWorkflowRunOverlay", () => {
  it("adds latest step status to matching canvas nodes", () => {
    const projection = buildWorkflowGraphProjection({
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [
        { id: "set_customer", type: "builtin.set" },
        { id: "review", type: "agent.call" },
        { id: "exit", type: "builtin.exit" },
      ],
    });

    const annotated = applyWorkflowRunOverlay(projection, {
      run: { currentNodeId: null },
      steps: [
        {
          id: "step_old",
          nodeId: "review",
          attempt: 1,
          status: "failed",
        },
        {
          id: "step_retry",
          nodeId: "review",
          attempt: 2,
          status: "succeeded",
        },
      ],
    });

    expect(annotated.nodes.find((node) => node.id === "review")?.data).toEqual(
      expect.objectContaining({
        runStatus: "succeeded",
        runStepId: "step_retry",
        runAttempt: 2,
        runCurrent: false,
      }),
    );
    expect(
      annotated.nodes.find((node) => node.id === "set_customer")?.data,
    ).not.toHaveProperty("runStatus");
    expect(
      annotated.nodes.find((node) => node.id === "trigger:manual")?.data,
    ).not.toHaveProperty("runStatus");
  });

  it("marks the current node as running when no step attempt exists yet", () => {
    const projection = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        { id: "queued_step", type: "builtin.set" },
        { id: "exit", type: "builtin.exit" },
      ],
    });

    const annotated = applyWorkflowRunOverlay(projection, {
      run: { currentNodeId: "queued_step" },
      steps: [],
    });

    expect(
      annotated.nodes.find((node) => node.id === "queued_step")?.data,
    ).toEqual(
      expect.objectContaining({
        runStatus: "running",
        runStepId: null,
        runAttempt: null,
        runCurrent: true,
      }),
    );
  });

  it("returns the latest step id for a canvas node", () => {
    expect(
      latestWorkflowRunStepIdForNode(
        [
          {
            id: "old_attempt",
            nodeId: "missing_customer",
            attempt: 1,
            status: "failed",
          },
          {
            id: "latest_attempt",
            nodeId: "missing_customer",
            attempt: 2,
            status: "failed",
          },
          {
            id: "other_step",
            nodeId: "log_customer",
            attempt: 1,
            status: "succeeded",
          },
        ],
        "missing_customer",
      ),
    ).toBe("latest_attempt");
    expect(latestWorkflowRunStepIdForNode([], "missing_customer")).toBeNull();
  });
});
