import { describe, expect, it } from "vitest";
import {
  buildHostedIntegrationEditorModel,
  type HostedIntegrationAdminFamilyRow,
} from "@/app/lib/hosted-integrations-admin";

describe("hosted integrations rich editor model", () => {
  it("focuses the selected tool handler and keeps unrelated handlers collapsed", () => {
    const row: HostedIntegrationAdminFamilyRow = {
      id: "qualys",
      name: "Qualys",
      version: 1,
      activeGeneration: {
        id: "gen_2",
        familyId: "qualys",
        sourceRevisionId: "source_rev_2",
        status: "active",
        promotedAt: "2026-08-12T00:00:00.000Z",
        promotedBy: "agent:tool-developer",
      },
      tools: [
        {
          name: "qualys_count_assets",
          title: "Count assets",
          description: "Count assets.",
          lifecycle: "active",
          inputSchema: { type: "object" },
          help: { summary: "Count help." },
          classification: {
            operation: "read",
            freshness: "live",
            idempotency: "idempotent",
            execution: "sync",
            approval: "none",
          },
        },
        {
          name: "qualys_search_assets",
          title: "Search assets",
          description: "Search assets.",
          lifecycle: "active",
          classification: {
            operation: "read",
            freshness: "live",
            idempotency: "idempotent",
            execution: "sync",
            approval: "none",
          },
        },
      ],
      environmentConfigs: [],
      failureBuckets: [],
      openFailureBucketCount: 0,
      lock: {
        id: "lock_1",
        familyId: "qualys",
        lockedBy: "web-settings",
        expiresAt: "2026-08-12T01:00:00.000Z",
      },
    };

    const model = buildHostedIntegrationEditorModel({
      row,
      selectedToolName: "qualys_count_assets",
      lock: row.lock,
      actorId: "web-settings",
      sourceView: {
        mode: "focused",
        manifest: { tool: row.tools[0]! },
        source: {
          selectedHandler: {
            name: "tool_qualys_count_assets",
            startLine: 5,
            endLine: 6,
            source:
              "def tool_qualys_count_assets(args, context):\n    return {}",
          },
          hooks: [],
          helpers: [],
          collapsedToolHandlers: [
            {
              toolName: "qualys_search_assets",
              functionName: "tool_qualys_search_assets",
              source: "def tool_qualys_search_assets(...):",
            },
          ],
        },
        diagnostics: [],
      },
    });

    expect(model).toMatchObject({
      selectedHandlerName: "tool_qualys_count_assets",
      helpSummary: "Count help.",
      inputSchema: { type: "object" },
      canManage: true,
      canEdit: true,
      canRunReadSafeDebug: true,
      collapsedHandlerNames: ["tool_qualys_search_assets"],
      focusedHandlerCode: expect.stringContaining(
        "def tool_qualys_count_assets",
      ),
    });
  });

  it("disables edit and debug controls for humans without management permission", () => {
    const row: HostedIntegrationAdminFamilyRow = {
      id: "qualys",
      name: "Qualys",
      version: 1,
      activeGeneration: null,
      tools: [
        {
          name: "qualys_count_assets",
          title: "Count assets",
          description: "Count assets.",
          lifecycle: "active",
          classification: {
            operation: "read",
            freshness: "live",
            idempotency: "idempotent",
            execution: "sync",
            approval: "none",
          },
        },
      ],
      environmentConfigs: [],
      failureBuckets: [],
      openFailureBucketCount: 0,
      lock: {
        id: "lock_1",
        familyId: "qualys",
        lockedBy: "web-settings",
        expiresAt: "2026-08-12T01:00:00.000Z",
      },
    };

    const model = buildHostedIntegrationEditorModel({
      row,
      selectedToolName: "qualys_count_assets",
      lock: row.lock,
      actorId: "web-settings",
      actorCanManage: false,
      sourceView: null,
    });

    expect(model).toMatchObject({
      canManage: false,
      canEdit: false,
      canRunReadSafeDebug: false,
    });
  });
});
