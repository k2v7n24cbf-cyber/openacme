import { describe, expect, it } from "vitest";
import {
  normalizeWorkflowDefinitionUi,
  parseWorkflowDefinitionUi,
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

  it("normalizes layout to known nodes with finite positions", () => {
    expect(
      normalizeWorkflowDefinitionUi(
        {
          canvas: {
            nodes: {
              keep: { position: { x: 120, y: 80 } },
              drop_missing: { position: { x: 1, y: 2 } },
              drop_invalid: { position: { x: Number.NaN, y: 2 } },
            },
          },
        },
        [{ id: "keep" }, { id: "drop_invalid" }],
      ),
    ).toEqual({
      canvas: {
        nodes: {
          keep: { position: { x: 120, y: 80 } },
        },
      },
    });
  });

  it("parses imported UI metadata", () => {
    expect(
      parseWorkflowDefinitionUi({
        canvas: {
          nodes: {
            set_customer: { position: { x: 120, y: 80 } },
          },
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        canvas: {
          nodes: {
            set_customer: { position: { x: 120, y: 80 } },
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
