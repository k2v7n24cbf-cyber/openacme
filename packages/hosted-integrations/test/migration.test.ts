import { describe, expect, it } from "vitest";
import {
  EXPECTED_LEGACY_INTEGRATION_HUB_TOOL_NAMES,
  LEGACY_INTEGRATION_HUB_INVENTORY,
  validateLegacyIntegrationHubMigrationInventory,
  type LegacyIntegrationHubInventory,
} from "../src/index.js";

describe("legacy integration-hub migration inventory", () => {
  it("captures every expected legacy tool name", () => {
    const result = validateLegacyIntegrationHubMigrationInventory(
      LEGACY_INTEGRATION_HUB_INVENTORY,
    );

    expect(result).toEqual({ ok: true, diagnostics: [] });
    expect(
      LEGACY_INTEGRATION_HUB_INVENTORY.tools.map(
        (entry) => entry.legacyToolName,
      ),
    ).toEqual(expect.arrayContaining([...EXPECTED_LEGACY_INTEGRATION_HUB_TOOL_NAMES]));
  });

  it("maps env requirements to config keys and secret refs", () => {
    for (const family of LEGACY_INTEGRATION_HUB_INVENTORY.families) {
      expect([...family.configKeys, ...family.secretRefs].length).toBeGreaterThan(0);
    }
    for (const entry of LEGACY_INTEGRATION_HUB_INVENTORY.tools) {
      expect([...entry.configKeys, ...entry.secretRefs].length).toBeGreaterThan(0);
    }
  });

  it("rejects missing or duplicate hosted migration targets", () => {
    const inventory: LegacyIntegrationHubInventory = {
      ...LEGACY_INTEGRATION_HUB_INVENTORY,
      tools: [
        {
          ...LEGACY_INTEGRATION_HUB_INVENTORY.tools[0]!,
          legacyToolName: "tool_a",
          legacyMcpToolName: "mcp_integration-hub__tool_a",
          hostedToolName: "duplicate_target",
        },
        {
          ...LEGACY_INTEGRATION_HUB_INVENTORY.tools[1]!,
          legacyToolName: "tool_b",
          legacyMcpToolName: "mcp_integration-hub__tool_b",
          hostedToolName: "duplicate_target",
        },
      ],
    };

    expect(
      validateLegacyIntegrationHubMigrationInventory(inventory, [
        "tool_a",
        "tool_b",
        "missing_tool",
      ]),
    ).toEqual({
      ok: false,
      diagnostics: [
        "missing legacy tool: missing_tool",
        "duplicate hosted tool: duplicate_target",
      ],
    });
  });
});
