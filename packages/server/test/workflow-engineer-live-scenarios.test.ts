import { describe, expect, it } from "vitest";
import {
  WorkflowNodeSchema,
  WorkflowTriggerSchema,
  getWorkflowCardCatalog,
} from "@openacme/workflows";
import { WORKFLOW_ENGINEER_LIVE_SCENARIOS } from "./e2e/support/workflow-engineer-live-scenarios.js";

describe("workflow engineer live dogfood scenarios", () => {
  it("declares exactly 15 cases with at least 5 complex cases", () => {
    expect(WORKFLOW_ENGINEER_LIVE_SCENARIOS).toHaveLength(15);
    expect(
      WORKFLOW_ENGINEER_LIVE_SCENARIOS.filter((scenario) => scenario.complex),
    ).toHaveLength(5);
  });

  it("declares required cards and expected evidence for every case", () => {
    const catalogTypes = new Set(
      getWorkflowCardCatalog().map((card) => card.type),
    );

    for (const scenario of WORKFLOW_ENGINEER_LIVE_SCENARIOS) {
      expect(scenario.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
      expect(scenario.requiredCards.length).toBeGreaterThan(0);
      expect(scenario.expectedEvidence.length).toBeGreaterThan(0);
      for (const type of scenario.requiredCards) {
        expect(catalogTypes.has(type as never)).toBe(true);
      }
    }
  });

  it("uses schema-valid node and trigger shapes", () => {
    for (const scenario of WORKFLOW_ENGINEER_LIVE_SCENARIOS) {
      for (const node of scenario.definition.nodes) {
        expect(WorkflowNodeSchema.safeParse(node).success).toBe(true);
      }
      for (const trigger of scenario.definition.triggers ?? []) {
        expect(WorkflowTriggerSchema.safeParse(trigger).success).toBe(true);
      }
    }
  });
});
