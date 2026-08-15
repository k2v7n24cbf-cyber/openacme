import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../src/registry.js";

function makeRegistry(names: string[]): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of names) {
    reg.register({
      name,
      toolset: "test",
      description: `tool ${name}`,
      parameters: z.object({}),
      handler: async () => JSON.stringify({ ok: true }),
    });
  }
  return reg;
}

describe("model-facing tool emission order", () => {
  it("getVercelTools emits name-sorted regardless of registration order", () => {
    const a = makeRegistry(["zeta", "alpha", "mid"]);
    const b = makeRegistry(["mid", "zeta", "alpha"]);
    expect(Object.keys(a.getVercelTools())).toEqual(["alpha", "mid", "zeta"]);
    expect(Object.keys(a.getVercelTools())).toEqual(
      Object.keys(b.getVercelTools())
    );
  });

  it("getDefinitions emits name-sorted regardless of registration order", () => {
    const a = makeRegistry(["zeta", "alpha", "mid"]);
    expect(a.getDefinitions().map((d) => d.function.name)).toEqual([
      "alpha",
      "mid",
      "zeta",
    ]);
  });

  it("getEmittedToolNames mirrors getVercelTools filtering without building tools", () => {
    const reg = makeRegistry(["zeta", "alpha", "mid"]);
    reg.register({
      name: "hidden",
      toolset: "test",
      description: "hidden tool",
      parameters: z.object({}),
      checkFn: () => false,
      handler: async () => JSON.stringify({ ok: true }),
    });

    const selected = new Set(["zeta", "hidden", "missing"]);

    expect(reg.getEmittedToolNames(selected)).toEqual(["zeta"]);
    expect(reg.getEmittedToolNames()).toEqual(["alpha", "mid", "zeta"]);
    expect(reg.getEmittedToolNames(selected)).toEqual(
      Object.keys(reg.getVercelTools(selected)),
    );
  });
});
