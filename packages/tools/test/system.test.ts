import { describe, expect, it } from "vitest";
import { SYSTEM_TOOLS } from "../src/system.js";

describe("SYSTEM_TOOLS", () => {
  it("exposes objective tools to normal agents", () => {
    expect(SYSTEM_TOOLS).toEqual(
      expect.arrayContaining([
        "objective_create",
        "objective_view",
        "objective_list",
        "objective_update",
        "objective_attach_task",
        "objective_detach_task",
        "objective_close",
        "objective_event",
      ]),
    );
  });
});
