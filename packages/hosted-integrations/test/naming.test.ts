import { describe, expect, it } from "vitest";
import {
  buildHostedToolName,
  HOSTED_TOOL_NAME_MAX_LENGTH,
  HostedToolNameSchema,
  parseHostedToolName,
} from "../src/index.js";

describe("hosted tool naming", () => {
  it("builds and parses hosted canonical tool names", () => {
    const name = buildHostedToolName({
      familyId: "splunk",
      toolName: "splunk_search",
    });

    expect(name).toBe("hosted_splunk__splunk_search");
    expect(parseHostedToolName(name)).toEqual({
      familyId: "splunk",
      toolName: "splunk_search",
    });
  });

  it("preserves hyphenated families and underscored native tool names", () => {
    const name = buildHostedToolName({
      familyId: "defender-alert",
      toolName: "defender_alert_get",
    });

    expect(name).toBe("hosted_defender-alert__defender_alert_get");
    expect(parseHostedToolName(name)).toEqual({
      familyId: "defender-alert",
      toolName: "defender_alert_get",
    });
  });

  it("rejects invalid family or native tool segments", () => {
    expect(() =>
      buildHostedToolName({
        familyId: "Defender Alert",
        toolName: "defender_alert_get",
      }),
    ).toThrow();
    expect(() =>
      buildHostedToolName({
        familyId: "defender-alert",
        toolName: "defender-alert-search",
      }),
    ).toThrow();
    expect(
      HostedToolNameSchema.safeParse(
        "hosted_qualys__bad__tool",
      ).success,
    ).toBe(false);
  });

  it("rejects provider-incompatible hosted names without aliasing", () => {
    const longToolName = `a_${"x".repeat(
      HOSTED_TOOL_NAME_MAX_LENGTH,
    )}`;

    expect(() =>
      buildHostedToolName({
        familyId: "qualys",
        toolName: longToolName,
      }),
    ).toThrow(/invalid hosted tool name/);
  });

  it("returns null when parsing non-hosted names", () => {
    expect(parseHostedToolName("splunk_search")).toBeNull();
    expect(
      parseHostedToolName(
        "mcp_integration-hub__splunk_search",
      ),
    ).toBeNull();
  });
});
