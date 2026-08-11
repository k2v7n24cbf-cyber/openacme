import { describe, expect, it } from "vitest";
import {
  beautifyWorkflowCanvasPositions,
  normalizeWorkflowDefinitionUi,
  parseWorkflowDefinitionUi,
  updateWorkflowCanvasNodeDetached,
  updateWorkflowCanvasNodePosition,
} from "@/app/workflows/layout";

describe("workflow canvas layout metadata", () => {
  it("updates a node position without dropping other layout metadata", () => {
    expect(
      updateWorkflowCanvasNodePosition(
        {
          canvas: {
            nodes: {
              existing: { position: { x: 1, y: 2 } },
            },
          },
        },
        "moved",
        { x: 120, y: 80 },
      ),
    ).toEqual({
      canvas: {
        nodes: {
          existing: { position: { x: 1, y: 2 } },
          moved: { position: { x: 120, y: 80 } },
        },
      },
    });
  });

  it("updates a node detached flag without dropping its position", () => {
    expect(
      updateWorkflowCanvasNodeDetached(
        {
          canvas: {
            nodes: {
              loose: { position: { x: 40, y: 60 } },
            },
          },
        },
        "loose",
        true,
      ),
    ).toEqual({
      canvas: {
        nodes: {
          loose: { position: { x: 40, y: 60 }, detached: true },
        },
      },
    });
  });

  it("normalizes layout to known nodes with finite positions", () => {
    expect(
      normalizeWorkflowDefinitionUi(
        {
          canvas: {
            nodes: {
              keep: { position: { x: 120, y: 80 } },
              drop_missing: { position: { x: 1, y: 2 } },
              drop_invalid: { position: { x: Number.NaN, y: 2 } },
              detached: { position: { x: 40, y: 60 }, detached: true },
            },
          },
        },
        [{ id: "keep" }, { id: "drop_invalid" }, { id: "detached" }],
      ),
    ).toEqual({
      canvas: {
        nodes: {
          keep: { position: { x: 120, y: 80 } },
          detached: { position: { x: 40, y: 60 }, detached: true },
        },
      },
    });
  });

  it("beautifies canvas positions from projected step nodes only", () => {
    expect(
      beautifyWorkflowCanvasPositions(
        {
          canvas: {
            nodes: {
              stale: { position: { x: 1, y: 2 } },
              step_a: { position: { x: 10, y: 20 }, detached: true },
            },
          },
        },
        [
          {
            id: "trigger:manual",
            position: { x: 0, y: 0 },
            data: { kind: "trigger" },
          },
          {
            id: "step_a",
            position: { x: 120.4, y: 80.6 },
            data: { kind: "step" },
          },
          {
            id: "group:loop:body",
            position: { x: 200, y: 80 },
            data: { kind: "group" },
          },
        ],
      ),
    ).toEqual({
      canvas: {
        nodes: {
          step_a: { position: { x: 120, y: 81 } },
        },
      },
    });
  });

  it("parses imported UI metadata", () => {
    expect(
      parseWorkflowDefinitionUi({
        canvas: {
          nodes: {
            set_customer: { position: { x: 120, y: 80 }, detached: true },
          },
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        canvas: {
          nodes: {
            set_customer: { position: { x: 120, y: 80 }, detached: true },
          },
        },
      },
    });

    expect(
      parseWorkflowDefinitionUi({
        canvas: {
          nodes: {
            set_customer: { position: { x: "left", y: 80 } },
          },
        },
      }),
    ).toEqual({
      ok: false,
      error:
        "Imported workflow ui.canvas.nodes.set_customer.position must have finite x and y numbers",
    });
  });
});
