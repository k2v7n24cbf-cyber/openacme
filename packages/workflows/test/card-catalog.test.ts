import { describe, expect, it } from "vitest";
import {
  getWorkflowCardCatalog,
  WorkflowAuthoringNodeTypeValues,
} from "../src/index.js";

describe("workflow card catalog", () => {
  it("covers every authorable workflow node type exactly once", () => {
    const catalog = getWorkflowCardCatalog();
    const catalogTypes = catalog.map((item) => item.type);

    expect(catalogTypes).toEqual(WorkflowAuthoringNodeTypeValues);
    expect(new Set(catalogTypes).size).toBe(catalogTypes.length);
  });

  it("does not expose deprecated or generic authoring cards", () => {
    const types = getWorkflowCardCatalog().map((item) => item.type);

    expect(types).not.toContain("builtin.if_else");
    expect(types).not.toContain("builtin.transform");
    expect(types).toContain("builtin.output.set");
    expect(types).toContain("builtin.transform.uri_parse");
    expect(types).toContain("builtin.transform.object_pick");
  });

  it("describes config, output, routes, and examples for every card", () => {
    for (const item of getWorkflowCardCatalog()) {
      expect(item.label).not.toEqual("");
      expect(item.description).not.toEqual("");
      expect(item.configSchema).toBeDefined();
      expect(item.defaultConfig).toBeDefined();
      expect(item.outputSchema).toBeDefined();
      expect(Array.isArray(item.routePorts)).toBe(true);
      expect(item.examples.length).toBeGreaterThan(0);
    }
  });

  it("documents multi-route semantics for control-flow cards", () => {
    const catalog = new Map(
      getWorkflowCardCatalog().map((item) => [item.type, item]),
    );

    expect(catalog.get("builtin.if")?.routePorts.map((port) => port.field))
      .toEqual(["then", "else", "next"]);
    expect(
      catalog.get("builtin.switch")?.routePorts.map((port) => port.field),
    ).toEqual(["cases", "default", "next"]);
    expect(
      catalog.get("builtin.foreach")?.routePorts.map((port) => port.field),
    ).toEqual(["body", "next"]);
    expect(
      catalog.get("builtin.parallel")?.routePorts.map((port) => port.field),
    ).toEqual(["branches", "next"]);
  });
});
