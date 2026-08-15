import { describe, expect, it } from "vitest";
import {
  buildHostedIntegrationManagedToolName,
  HOSTED_INTEGRATION_MANAGED_TOOL_NAME_MAX_LENGTH,
  HostedIntegrationManagedToolNameSchema,
  parseHostedIntegrationManagedToolName,
} from "../src/index.js";

describe("hosted integration managed tool naming", () => {
  it("builds and parses managed canonical tool names", () => {
    const name = buildHostedIntegrationManagedToolName({
      familyId: "splunk",
      toolName: "splunk_search",
    });

    expect(name).toBe("managed_splunk__splunk_search");
    expect(parseHostedIntegrationManagedToolName(name)).toEqual({
      familyId: "splunk",
      toolName: "splunk_search",
    });
  });

  it("preserves hyphenated families and underscored native tool names", () => {
    const name = buildHostedIntegrationManagedToolName({
      familyId: "defender-alert",
      toolName: "defender_alert_get",
    });

    expect(name).toBe("managed_defender-alert__defender_alert_get");
    expect(parseHostedIntegrationManagedToolName(name)).toEqual({
      familyId: "defender-alert",
      toolName: "defender_alert_get",
    });
  });

  it("rejects invalid family or native tool segments", () => {
    expect(() =>
      buildHostedIntegrationManagedToolName({
        familyId: "Defender Alert",
        toolName: "defender_alert_get",
      }),
    ).toThrow();
    expect(() =>
      buildHostedIntegrationManagedToolName({
        familyId: "defender-alert",
        toolName: "defender-alert-search",
      }),
    ).toThrow();
    expect(
      HostedIntegrationManagedToolNameSchema.safeParse(
        "managed_qualys__bad__tool",
      ).success,
    ).toBe(false);
  });

  it("rejects provider-incompatible managed names without aliasing", () => {
    const longToolName = `a_${"x".repeat(
      HOSTED_INTEGRATION_MANAGED_TOOL_NAME_MAX_LENGTH,
    )}`;

    expect(() =>
      buildHostedIntegrationManagedToolName({
        familyId: "qualys",
        toolName: longToolName,
      }),
    ).toThrow(/invalid managed hosted integration tool name/);
  });

  it("returns null when parsing non-managed names", () => {
    expect(parseHostedIntegrationManagedToolName("splunk_search")).toBeNull();
    expect(
      parseHostedIntegrationManagedToolName(
        "mcp_integration-hub__splunk_search",
      ),
    ).toBeNull();
  });
});
