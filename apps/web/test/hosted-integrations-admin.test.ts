import { describe, expect, it } from "vitest";
import {
  hostedIntegrationCodeActionAccessibleLabels,
  hostedIntegrationCodeEmptyStateText,
  buildHostedIntegrationCodeActionState,
  buildHostedIntegrationArtifactActionState,
  buildHostedIntegrationDebugActionState,
  buildHostedIntegrationExecutionLogActionState,
  buildHostedIntegrationExecutionLogRows,
  buildHostedIntegrationDraftFileActionState,
  buildHostedIntegrationPackageActionState,
  hostedIntegrationDraftFileActionAccessibleLabels,
  hostedIntegrationEditorModeLabel,
  hostedIntegrationEditorSectionAccessibleLabel,
  buildHostedIntegrationEditorModel,
  buildHostedIntegrationExampleActionState,
  hostedIntegrationExampleActionAccessibleLabels,
  hostedIntegrationExampleEmptyStateText,
  hostedIntegrationExamplePayloadAccessibleLabel,
  hostedIntegrationExampleResultAccessibleLabel,
  hostedIntegrationExampleSelectorAccessibleLabel,
  buildHostedIntegrationFailureBucketActionState,
  buildHostedIntegrationFailureSummaryState,
  buildHostedIntegrationPackagePreviewState,
  buildHostedIntegrationPublishActionState,
  buildHostedIntegrationPublishViewState,
  buildHostedIntegrationToolMappings,
  buildHostedIntegrationVersionActionState,
  buildHostedIntegrationVersionRows,
  buildHostedIntegrationsAdminRows,
  countHostedIntegrationAssignedOpenFailureBuckets,
  filterHostedIntegrationExecutionLogRows,
  hostedIntegrationDebugActionAccessibleLabel,
  hostedIntegrationDebugArgumentsAccessibleLabel,
  hostedIntegrationDebugEnvironmentConfigAccessibleLabel,
  hostedIntegrationDebugResultAccessibleLabel,
  hostedIntegrationDebugUnavailableReason,
  hostedIntegrationConfigEmptyStateText,
  hostedIntegrationEnvironmentConfigAccessibleLabel,
  hostedIntegrationEditLockActionAccessibleLabels,
  hostedIntegrationExecutionLogDetailAccessibleLabels,
  hostedIntegrationExecutionLogPrimaryHeader,
  hostedIntegrationExecutionLogRowAccessibleLabel,
  hostedIntegrationFamilyNavigationAccessibleLabel,
  hostedIntegrationFileEditorAccessibleLabel,
  hostedIntegrationFileEmptyStateText,
  hostedIntegrationFileModeAccessibleLabel,
  hostedIntegrationFileNavigationAccessibleLabel,
  hostedIntegrationFailureBucketActionAccessibleLabels,
  hostedIntegrationFailureBucketAccessibleLabel,
  hostedIntegrationFailureBucketHitLabel,
  hostedIntegrationHandlerName,
  hostedIntegrationLogScopeAccessibleLabel,
  hostedIntegrationPackageActionAccessibleLabels,
  hostedIntegrationPublishAccessibleLabels,
  hostedIntegrationRefreshActionAccessibleLabel,
  hostedIntegrationRefreshLogsAccessibleLabel,
  hostedIntegrationSecretActionAccessibleLabel,
  hostedIntegrationSecretInputAccessibleLabel,
  hostedIntegrationSecretStatusLabel,
  buildHostedIntegrationToolHelpActionState,
  buildHostedIntegrationAgentBindingMatrix,
  hostedIntegrationToolHelpActionAccessibleLabels,
  hostedIntegrationToolHelpEmptyStateText,
  hostedIntegrationToolHelpExampleAccessibleLabels,
  hostedIntegrationToolHelpFieldAccessibleLabels,
  hostedIntegrationToolHelpParameterRowAccessibleLabels,
  hostedIntegrationToolNavigationAccessibleLabel,
  hostedIntegrationVersionActionAccessibleLabels,
  hostedIntegrationVersionEmptyStateText,
  hostedIntegrationVersionRowAccessibleLabel,
  selectHostedIntegrationEditableSourcePath,
  shouldBlockHostedIntegrationFamilyNavigation,
} from "@/app/lib/hosted-integrations-admin";

describe("hosted integrations admin view model", () => {
  it("groups hosted-tool agent binding matrix rows for human inspection", () => {
    const matrix = buildHostedIntegrationAgentBindingMatrix({
      familyId: "qualys",
      toolName: "qualys_count_assets",
      hostedToolName: "hosted_qualys__qualys_count_assets",
      bindings: [
        {
          agentId: "internal-parity",
          agentName: "Internal Parity",
          hostedToolName: "hosted_qualys__qualys_count_assets",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          bindingKind: "internal",
          allowedEnvironments: ["test_debug"],
          defaultEnvironment: "test_debug",
          generationPin: { type: "generation", generationId: "gen_1" },
          purpose: "parity",
          updatedAt: "2026-08-14T10:05:00.000Z",
          updatedBy: "agent:tool-developer",
        },
        {
          agentId: "analyst",
          agentName: "Analyst",
          hostedToolName: "hosted_qualys__qualys_count_assets",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          bindingKind: "agent",
          allowedEnvironments: ["prod", "test_debug"],
          defaultEnvironment: "prod",
          generationPin: { type: "current" },
          bindingNote: "normal runtime access",
          updatedAt: "2026-08-14T10:00:00.000Z",
          updatedBy: "human:alen",
        },
      ],
    });

    expect(matrix).toMatchObject({
      familyId: "qualys",
      toolName: "qualys_count_assets",
      hostedToolName: "hosted_qualys__qualys_count_assets",
      totalCount: 2,
      agentCount: 1,
      internalCount: 1,
      groups: [
        {
          kind: "agent",
          label: "Agents",
          rows: [
            {
              agentId: "analyst",
              defaultEnvironment: "prod",
              generationLabel: "Current generation",
              noteLabel: "normal runtime access",
            },
          ],
        },
        {
          kind: "internal",
          label: "Internal",
          rows: [
            {
              agentId: "internal-parity",
              defaultEnvironment: "test_debug",
              generationLabel: "Pinned to gen_1",
              noteLabel: "parity",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(matrix)).not.toContain("secret");
    expect(JSON.stringify(matrix)).not.toContain("endpoint");
  });

  it("aggregates families with active generation, scopes, locks, and open bucket counts", () => {
    const rows = buildHostedIntegrationsAdminRows({
      families: [
        {
          id: "qualys",
          name: "Qualys",
          version: 2,
          toolNames: ["qualys_count_assets"],
          status: "active",
        },
      ],
      familyDetails: [
        {
          summary: {
            id: "qualys",
            name: "Qualys",
            version: 2,
            toolNames: ["qualys_count_assets"],
            status: "active",
          },
          manifest: {
            id: "qualys",
            name: "Qualys",
            version: 2,
          },
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
        },
      ],
      generations: [
        {
          id: "gen_1",
          familyId: "qualys",
          sourceRevisionId: "source_rev_1",
          status: "active",
          promotedAt: "2026-08-12T00:00:00.000Z",
          promotedBy: "agent:tool-developer",
        },
      ],
      environmentConfigs: [
        {
          id: "qualys-prod",
          familyId: "qualys",
          revision: 1,
          environment: "prod",
          config: { QUALYS_BASE_URL: "https://qualys.example" },
          secrets: {
            QUALYS_TOKEN: { configured: true },
            QUALYS_UNUSED: { configured: false },
          },
          updatedAt: "2026-08-12T00:00:00.000Z",
          updatedBy: "human:alen",
        },
      ],
      failureBuckets: [
        {
          id: "bucket_open",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          generationId: "gen_1",
          status: "open",
          count: 2,
          latestSeenAt: "2026-08-12T00:00:00.000Z",
        },
        {
          id: "bucket_closed",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          generationId: "gen_1",
          status: "closed",
          count: 1,
          latestSeenAt: "2026-08-12T00:00:00.000Z",
        },
      ],
      locks: [
        {
          id: "lock_1",
          familyId: "qualys",
          lockedBy: "agent:tool-developer",
          expiresAt: "2026-08-12T01:00:00.000Z",
        },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "qualys",
      activeGeneration: { id: "gen_1" },
      openFailureBucketCount: 1,
      lock: { id: "lock_1" },
      environmentConfigs: [
        {
          id: "qualys-prod",
          environment: "prod",
          revision: 1,
          configKeyCount: 1,
          configuredSecretCount: 1,
          configKeys: [{ name: "QUALYS_BASE_URL" }],
          secretKeys: [
            { name: "QUALYS_TOKEN", configured: true },
            { name: "QUALYS_UNUSED", configured: false },
          ],
        },
      ],
    });
    expect(rows[0]?.failureBuckets.map((bucket) => bucket.id)).toEqual([
      "bucket_open",
      "bucket_closed",
    ]);
    expect(rows[0]?.tools.map((tool) => tool.name)).toEqual([
      "qualys_count_assets",
    ]);
    expect(JSON.stringify(rows)).not.toContain("secret-value");
  });

  it("deduplicates repeated family summaries by id before rendering rows", () => {
    const rows = buildHostedIntegrationsAdminRows({
      families: [
        {
          id: "qualys",
          name: "Qualys",
          version: 1,
          toolNames: ["qualys_count_assets"],
          status: "active",
        },
        {
          id: "qualys",
          name: "Qualys",
          version: 2,
          toolNames: ["qualys_count_assets"],
          status: "active",
        },
      ],
      familyDetails: [],
      generations: [],
      environmentConfigs: [],
      failureBuckets: [],
      locks: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "qualys", version: 2 });
  });

  it("keeps active family summaries ahead of proposed duplicates at the same version", () => {
    const rows = buildHostedIntegrationsAdminRows({
      families: [
        {
          id: "real-dogfood",
          name: "Real LLM Dogfood Tools",
          version: 1,
          toolNames: ["real_echo"],
          status: "active",
        },
        {
          id: "real-dogfood",
          name: "Proposed Dogfood Draft",
          version: 1,
          toolNames: ["proposed_echo"],
          status: "proposed",
        },
      ],
      familyDetails: [],
      generations: [],
      environmentConfigs: [],
      failureBuckets: [],
      locks: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "real-dogfood",
      name: "Real LLM Dogfood Tools",
      version: 1,
    });
  });

  it("builds deterministic tool mappings and focused editor model", () => {
    const row = buildHostedIntegrationsAdminRows({
      families: [
        {
          id: "qualys",
          name: "Qualys",
          version: 2,
          toolNames: ["qualys_count_assets", "qualys_search_assets"],
          status: "active",
        },
      ],
      familyDetails: [
        {
          summary: {
            id: "qualys",
            name: "Qualys",
            version: 2,
            toolNames: ["qualys_count_assets", "qualys_search_assets"],
            status: "active",
          },
          manifest: {
            id: "qualys",
            name: "Qualys",
            version: 2,
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
        },
      ],
      generations: [],
      environmentConfigs: [],
      failureBuckets: [],
      locks: [
        {
          id: "lock_1",
          familyId: "qualys",
          lockedBy: "web-settings",
          expiresAt: "2026-08-12T01:00:00.000Z",
        },
      ],
    })[0]!;

    expect(hostedIntegrationHandlerName("qualys_count_assets")).toBe(
      "tool_qualys_count_assets",
    );
    expect(
      buildHostedIntegrationToolMappings({
        row,
        selectedToolName: "qualys_count_assets",
      }),
    ).toEqual([
      expect.objectContaining({
        toolName: "qualys_count_assets",
        handlerName: "tool_qualys_count_assets",
        selected: true,
      }),
      expect.objectContaining({
        toolName: "qualys_search_assets",
        handlerName: "tool_qualys_search_assets",
        selected: false,
      }),
    ]);

    expect(
      buildHostedIntegrationEditorModel({
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
              startLine: 10,
              endLine: 12,
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
      }),
    ).toMatchObject({
      selectedToolName: "qualys_count_assets",
      selectedHandlerName: "tool_qualys_count_assets",
      focusedHandlerCode: expect.stringContaining(
        "def tool_qualys_count_assets",
      ),
      collapsedHandlerNames: ["tool_qualys_search_assets"],
      helpSummary: "Count help.",
      inputSchema: { type: "object" },
      canEdit: true,
    });

    expect(
      buildHostedIntegrationEditorModel({
        row,
        selectedToolName: "",
        lock: row.lock,
        actorId: "web-settings",
        sourceView: null,
      }),
    ).toMatchObject({
      selectedToolName: null,
      selectedHandlerName: null,
      selectedTool: null,
      inputSchema: null,
      helpSummary: null,
    });
  });

  it("builds human-readable execution log rows without expanding raw details", () => {
    const row = {
      id: "qualys",
      name: "Qualys",
      version: 1,
      activeGeneration: {
        id: "gen_current",
        familyId: "qualys",
        sourceRevisionId: "source_rev_1",
        status: "active" as const,
        promotedAt: "2026-08-12T00:00:00.000Z",
        promotedBy: "agent:tool-developer",
      },
      tools: [],
      environmentConfigs: [],
      failureBuckets: [],
      openFailureBucketCount: 0,
      lock: null,
    };

    const rows = buildHostedIntegrationExecutionLogRows({
      row,
      runs: [
        {
          runId: "run_artifact",
          familyId: "qualys",
          toolName: "qualys_search_assets",
          generationId: "gen_current",
          actorId: "agent:analyst",
          environmentConfigId: "qualys-prod",
          configRevision: 3,
          sanitizedArgs: { query: "nginx" },
          status: "succeeded",
          startedAt: "2026-08-12T00:00:00.000Z",
          endedAt: "2026-08-12T00:00:02.000Z",
          durationMs: 2000,
          resultMetadata: {
            envelopeRef: "run_artifact/output.json",
            responseMode: "artifact",
            artifact: {
              name: "output.json",
              sizeBytes: 12000,
              estimatedTokens: 5000,
            },
          },
        },
        {
          runId: "run_failed",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          generationId: "gen_previous",
          actorId: "agent:analyst",
          environmentConfigId: "qualys-prod",
          configRevision: 2,
          sanitizedArgs: {},
          status: "failed",
          startedAt: "2026-08-11T00:00:00.000Z",
          error: { code: "tool_bug", message: "boom" },
        },
      ],
    });

    expect(rows).toMatchObject([
      {
        versionRelation: "current version",
        durationLabel: "2000 ms",
        resultLabel: "artifact",
        artifactName: "output.json",
        errorCode: null,
      },
      {
        versionRelation: "previous version",
        durationLabel: "not recorded",
        resultLabel: "failed",
        artifactName: null,
        errorCode: "tool_bug",
      },
    ]);
  });

  it("filters execution log rows to the selected tool unless family scope is requested", () => {
    const row = {
      id: "qualys",
      name: "Qualys",
      version: 1,
      activeGeneration: {
        id: "gen_current",
        familyId: "qualys",
        sourceRevisionId: "source_rev_1",
        status: "active" as const,
        promotedAt: "2026-08-12T00:00:00.000Z",
        promotedBy: "agent:tool-developer",
      },
      tools: [],
      environmentConfigs: [],
      failureBuckets: [],
      openFailureBucketCount: 0,
      lock: null,
    };
    const rows = buildHostedIntegrationExecutionLogRows({
      row,
      runs: [
        {
          runId: "run_count",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          generationId: "gen_current",
          actorId: "agent:analyst",
          environmentConfigId: "qualys-prod",
          configRevision: 3,
          sanitizedArgs: {},
          status: "succeeded",
          startedAt: "2026-08-12T00:00:00.000Z",
          durationMs: 10,
        },
        {
          runId: "run_search",
          familyId: "qualys",
          toolName: "qualys_search_assets",
          generationId: "gen_current",
          actorId: "agent:analyst",
          environmentConfigId: "qualys-prod",
          configRevision: 3,
          sanitizedArgs: {},
          status: "succeeded",
          startedAt: "2026-08-12T00:01:00.000Z",
          durationMs: 20,
        },
      ],
    });

    expect(
      filterHostedIntegrationExecutionLogRows({
        rows,
        selectedToolName: "qualys_count_assets",
        scope: "selected_tool",
      }).map((entry) => entry.run.runId),
    ).toEqual(["run_count"]);
    expect(
      filterHostedIntegrationExecutionLogRows({
        rows,
        selectedToolName: "qualys_count_assets",
        scope: "family",
      }).map((entry) => entry.run.runId),
    ).toEqual(["run_count", "run_search"]);
  });

  it("labels the execution log primary column according to scope", () => {
    expect(hostedIntegrationExecutionLogPrimaryHeader("selected_tool")).toBe(
      "Version",
    );
    expect(hostedIntegrationExecutionLogPrimaryHeader("family")).toBe("Tool");
  });

  it("builds a single accessible execution log row label", () => {
    const label = hostedIntegrationExecutionLogRowAccessibleLabel({
      primaryLabel: "current version",
      completedLabel: "8/14/2026, 12:35:57 AM",
      row: {
        versionRelation: "current version",
        completedAt: "2026-08-14T00:35:57.000Z",
        durationLabel: "2039 ms",
        resultLabel: "inline",
        artifactName: null,
        errorCode: null,
        run: {
          runId: "run_1",
          familyId: "qualys",
          toolName: "qualys_gav_asset_count",
          generationId: "gen_current",
          actorId: "agent:analyst",
          environmentConfigId: "qualys-test_debug",
          configRevision: 1,
          sanitizedArgs: {},
          status: "succeeded",
          startedAt: "2026-08-14T00:35:55.000Z",
          endedAt: "2026-08-14T00:35:57.000Z",
          durationMs: 2039,
        },
      },
    });

    expect(label).toBe(
      "Execution log, current version, qualys-test_debug, 8/14/2026, 12:35:57 AM, succeeded, inline, 2039 ms",
    );
    expect(label.match(/succeeded/g)).toHaveLength(1);
    expect(label.match(/2039 ms/g)).toHaveLength(1);
  });

  it("labels execution log details with the selected run and artifact target", () => {
    expect(
      hostedIntegrationExecutionLogDetailAccessibleLabels({
        runId: "run_1",
        artifactName: "response.json",
      }),
    ).toEqual({
      sanitizedArguments: "Sanitized arguments for run run_1",
      error: "Error for run run_1",
      artifact: "Artifact response.json for run run_1",
      loadArtifact: "Load artifact response.json for run run_1",
    });

    expect(
      hostedIntegrationExecutionLogDetailAccessibleLabels({
        runId: "",
        artifactName: null,
      }),
    ).toEqual({
      sanitizedArguments: "Sanitized arguments for run selected run",
      error: "Error for run selected run",
      artifact: "Artifact selected artifact for run selected run",
      loadArtifact: "Load artifact selected artifact for run selected run",
    });
  });

  it("shows log refresh only for an actionable log target", () => {
    expect(
      buildHostedIntegrationExecutionLogActionState({
        scope: "selected_tool",
        selectedToolName: "qualys_gav_asset_count",
        familyId: "qualys",
        canManage: true,
      }),
    ).toEqual({
      target: {
        kind: "execution_logs",
        id: "selected_tool:qualys_gav_asset_count",
        ownedByCurrentHuman: true,
        ready: true,
      },
      canRefreshLogs: true,
    });

    expect(
      buildHostedIntegrationExecutionLogActionState({
        scope: "selected_tool",
        selectedToolName: "",
        familyId: "qualys",
        canManage: true,
      }),
    ).toEqual({
      target: null,
      canRefreshLogs: false,
    });

    expect(
      buildHostedIntegrationExecutionLogActionState({
        scope: "family",
        selectedToolName: "",
        familyId: "qualys",
        canManage: true,
      }),
    ).toEqual({
      target: {
        kind: "execution_logs",
        id: "family:qualys",
        ownedByCurrentHuman: true,
        ready: true,
      },
      canRefreshLogs: true,
    });

    expect(
      buildHostedIntegrationExecutionLogActionState({
        scope: "family",
        selectedToolName: "qualys_gav_asset_count",
        familyId: "qualys",
        canManage: false,
      }),
    ).toEqual({
      target: null,
      canRefreshLogs: false,
    });
  });

  it("shows artifact loading only for an actionable run artifact target", () => {
    expect(
      buildHostedIntegrationArtifactActionState({
        runId: "run_1",
        artifactName: "response.json",
        canManage: true,
      }),
    ).toEqual({
      target: {
        kind: "run_artifact",
        id: "run_1/response.json",
        ownedByCurrentHuman: true,
        ready: true,
      },
      canLoadArtifact: true,
    });

    expect(
      buildHostedIntegrationArtifactActionState({
        runId: "run_1",
        artifactName: null,
        canManage: true,
      }),
    ).toEqual({
      target: null,
      canLoadArtifact: false,
    });

    expect(
      buildHostedIntegrationArtifactActionState({
        runId: "run_1",
        artifactName: "response.json",
        canManage: false,
      }),
    ).toEqual({
      target: null,
      canLoadArtifact: false,
    });
  });

  it("builds version rows scoped to the selected family with rollback targets", () => {
    const row = {
      id: "qualys",
      name: "Qualys",
      version: 1,
      activeGeneration: {
        id: "gen_current",
        familyId: "qualys",
        sourceRevisionId: "source_rev_2",
        status: "active" as const,
        promotedAt: "2026-08-12T00:00:00.000Z",
        promotedBy: "agent:tool-developer",
      },
      tools: [],
      environmentConfigs: [],
      failureBuckets: [],
      openFailureBucketCount: 0,
      lock: null,
    };

    expect(
      buildHostedIntegrationVersionRows({
        row,
        generations: [
          row.activeGeneration,
          {
            id: "gen_previous",
            familyId: "qualys",
            sourceRevisionId: "source_rev_1",
            status: "retired",
            promotedAt: "2026-08-11T00:00:00.000Z",
            promotedBy: "agent:tool-developer",
          },
          {
            id: "gen_other_family",
            familyId: "jira",
            sourceRevisionId: "source_rev_jira",
            status: "active",
            promotedAt: "2026-08-13T00:00:00.000Z",
            promotedBy: "agent:tool-developer",
          },
        ],
      }),
    ).toMatchObject([
      {
        generation: { id: "gen_current" },
        relation: "current version",
        stateLabel: "active",
        canRollback: false,
      },
      {
        generation: { id: "gen_previous" },
        relation: "previous version",
        stateLabel: "retired",
        canRollback: true,
      },
    ]);
  });

  it("does not show stale active backend status for previous versions", () => {
    const row = {
      id: "qualys",
      name: "Qualys",
      version: 1,
      activeGeneration: {
        id: "gen_current",
        familyId: "qualys",
        sourceRevisionId: "source_rev_2",
        status: "active" as const,
        promotedAt: "2026-08-12T00:00:00.000Z",
        promotedBy: "agent:tool-developer",
      },
      tools: [],
      environmentConfigs: [],
      failureBuckets: [],
      openFailureBucketCount: 0,
      lock: null,
    };

    expect(
      buildHostedIntegrationVersionRows({
        row,
        generations: [
          row.activeGeneration,
          {
            id: "gen_previous_with_stale_active_status",
            familyId: "qualys",
            sourceRevisionId: "source_rev_1",
            status: "active",
            promotedAt: "2026-08-11T00:00:00.000Z",
            promotedBy: "agent:tool-developer",
          },
        ],
      })[1],
    ).toMatchObject({
      relation: "previous version",
      stateLabel: "previous",
      canRollback: true,
    });
  });

  it("builds a single accessible version row label", () => {
    const label = hostedIntegrationVersionRowAccessibleLabel({
      promotedLabel: "8/14/2026, 12:34:48 AM",
      row: {
        generation: {
          id: "gen_previous",
          familyId: "qualys",
          sourceRevisionId: "source_rev_1",
          status: "retired",
          promotedAt: "2026-08-14T00:34:48.000Z",
          promotedBy: "agent:live-parity-runner",
        },
        relation: "previous version",
        stateLabel: "retired",
        canRollback: true,
      },
    });

    expect(label).toBe(
      "previous version, agent:live-parity-runner, retired, 8/14/2026, 12:34:48 AM",
    );
    expect(label.match(/retired/g)).toHaveLength(1);
    expect(label.match(/8\/14\/2026/g)).toHaveLength(1);
  });

  it("shows version compare and rollback actions only after selecting a rollback target", () => {
    expect(
      buildHostedIntegrationVersionActionState({
        selectedVersionRow: null,
        canManage: true,
      }),
    ).toEqual({
      target: null,
      hasSelectedTarget: false,
      canCompare: false,
      canRollback: false,
    });

    expect(
      buildHostedIntegrationVersionActionState({
        canManage: true,
        selectedVersionRow: {
          generation: {
            id: "gen_current",
            familyId: "qualys",
            sourceRevisionId: "source_rev_2",
            status: "active",
            promotedAt: "2026-08-12T00:00:00.000Z",
            promotedBy: "agent:tool-developer",
          },
          relation: "current version",
          stateLabel: "active",
          canRollback: false,
        },
      }),
    ).toEqual({
      target: null,
      hasSelectedTarget: false,
      canCompare: false,
      canRollback: false,
    });

    expect(
      buildHostedIntegrationVersionActionState({
        canManage: true,
        activeGenerationId: "gen_current",
        selectedVersionRow: {
          generation: {
            id: "gen_previous",
            familyId: "qualys",
            sourceRevisionId: "source_rev_1",
            status: "retired",
            promotedAt: "2026-08-11T00:00:00.000Z",
            promotedBy: "agent:tool-developer",
          },
          relation: "previous version",
          stateLabel: "retired",
          canRollback: true,
        },
      }),
    ).toEqual({
      target: {
        kind: "previous_version",
        id: "gen_previous",
        ownedByCurrentHuman: true,
        ready: true,
      },
      hasSelectedTarget: true,
      canCompare: true,
      canRollback: true,
    });

    expect(
      buildHostedIntegrationVersionActionState({
        canManage: true,
        activeGenerationId: null,
        selectedVersionRow: {
          generation: {
            id: "gen_previous",
            familyId: "qualys",
            sourceRevisionId: "source_rev_1",
            status: "retired",
            promotedAt: "2026-08-11T00:00:00.000Z",
            promotedBy: "agent:tool-developer",
          },
          relation: "previous version",
          stateLabel: "retired",
          canRollback: true,
        },
      }),
    ).toEqual({
      target: {
        kind: "previous_version",
        id: "gen_previous",
        ownedByCurrentHuman: true,
        ready: true,
      },
      hasSelectedTarget: true,
      canCompare: false,
      canRollback: true,
    });

    expect(
      buildHostedIntegrationVersionActionState({
        canManage: false,
        selectedVersionRow: {
          generation: {
            id: "gen_previous",
            familyId: "qualys",
            sourceRevisionId: "source_rev_1",
            status: "retired",
            promotedAt: "2026-08-11T00:00:00.000Z",
            promotedBy: "agent:tool-developer",
          },
          relation: "previous version",
          stateLabel: "retired",
          canRollback: true,
        },
      }),
    ).toEqual({
      target: null,
      hasSelectedTarget: false,
      canCompare: false,
      canRollback: false,
    });
  });

  it("labels version actions with the selected previous-version target", () => {
    expect(
      hostedIntegrationVersionActionAccessibleLabels({
        selectedVersionRow: null,
        promotedLabel: null,
      }),
    ).toEqual({
      compare: "Compare selected previous version",
      rollback: "Rollback to selected previous version",
      diff: "Version diff for selected previous version",
      rollbackResult: "Rollback result for selected previous version",
    });

    expect(
      hostedIntegrationVersionActionAccessibleLabels({
        promotedLabel: "8/14/2026, 12:34:48 AM",
        selectedVersionRow: {
          generation: {
            id: "gen_previous",
            familyId: "qualys",
            sourceRevisionId: "source_rev_1",
            status: "retired",
            promotedAt: "2026-08-14T00:34:48.000Z",
            promotedBy: "agent:live-parity-runner",
          },
          relation: "previous version",
          stateLabel: "retired",
          canRollback: true,
        },
      }),
    ).toEqual({
      compare: "Compare previous version from 8/14/2026, 12:34:48 AM",
      rollback: "Rollback to previous version from 8/14/2026, 12:34:48 AM",
      diff: "Version diff for previous version from 8/14/2026, 12:34:48 AM",
      rollbackResult:
        "Rollback result for previous version from 8/14/2026, 12:34:48 AM",
    });

    expect(
      hostedIntegrationVersionEmptyStateText({
        state: "no_selected_previous_version",
        familyName: "Qualys",
      }),
    ).toBe("No previous version selected for Qualys.");

    expect(
      hostedIntegrationVersionEmptyStateText({
        state: "no_versions",
        familyName: "",
      }),
    ).toBe("No versions have been published for selected family yet.");
  });

  it("labels the validate/publish lane from the latest lifecycle state", () => {
    expect(
      buildHostedIntegrationPublishViewState({
        validation: null,
        publishResult: null,
      }),
    ).toEqual({
      validationOk: false,
      publishReady: false,
      publishBlocked: false,
      blockerLabel: null,
      tabLabel: "Validate",
      primaryLabel: "Validate",
      primaryAccessibleLabel: "Validate pending changes",
      resultLabel: null,
    });

    expect(
      buildHostedIntegrationPublishViewState({
        validation: { ok: false, diagnostics: [{ code: "bad_schema" }] },
        publishResult: null,
      }),
    ).toEqual({
      validationOk: false,
      publishReady: false,
      publishBlocked: false,
      blockerLabel: null,
      tabLabel: "Validate",
      primaryLabel: "Validate again",
      primaryAccessibleLabel: "Validate pending changes again",
      resultLabel: "Validation result",
    });

    expect(
      buildHostedIntegrationPublishViewState({
        validation: { ok: true, diagnostics: [] },
        publishResult: null,
      }),
    ).toEqual({
      validationOk: true,
      publishReady: true,
      publishBlocked: false,
      blockerLabel: null,
      tabLabel: "Publish",
      primaryLabel: "Publish",
      primaryAccessibleLabel: "Publish validated changes",
      resultLabel: "Validation result",
    });

    expect(
      buildHostedIntegrationPublishViewState({
        validation: { ok: true, diagnostics: [] },
        publishReadiness: {
          status: "blocked",
          code: "production_config_missing",
          blockers: [{ message: "prod config is missing" }],
        },
        publishResult: null,
      }),
    ).toEqual({
      validationOk: true,
      publishReady: false,
      publishBlocked: true,
      blockerLabel: "prod config is missing",
      tabLabel: "Blocked",
      primaryLabel: "Validate again",
      primaryAccessibleLabel: "Validate pending changes again",
      resultLabel: "Validation result",
    });

    expect(
      buildHostedIntegrationPublishViewState({
        validation: { ok: true, diagnostics: [] },
        publishResult: { ok: true },
      }).resultLabel,
    ).toBe("Publish result");

    expect(
      hostedIntegrationPublishAccessibleLabels({
        familyName: "Qualys",
        viewState: buildHostedIntegrationPublishViewState({
          validation: null,
          publishResult: null,
        }),
      }),
    ).toEqual({
      primary: "Validate pending changes for Qualys",
      result: "Validation result for Qualys pending changes",
      rawResult: "Show raw validation result for Qualys pending changes",
    });

    expect(
      hostedIntegrationPublishAccessibleLabels({
        familyName: "Qualys",
        viewState: buildHostedIntegrationPublishViewState({
          validation: { ok: true, diagnostics: [] },
          publishResult: { ok: true },
        }),
      }),
    ).toEqual({
      primary: "Publish validated changes for Qualys",
      result: "Publish result for Qualys pending changes",
      rawResult: "Show raw publish result for Qualys pending changes",
    });
  });

  it("shows validate and publish actions only for the current editable draft", () => {
    expect(
      buildHostedIntegrationPublishActionState({
        canEdit: false,
        draftId: "draft_1",
        validationOk: false,
        publishReady: false,
        busy: false,
        promotionNeedsHumanApproval: false,
      }),
    ).toEqual({
      target: null,
      hasEditableDraft: false,
      showLane: false,
      primaryDisabled: true,
    });

    expect(
      buildHostedIntegrationPublishActionState({
        canEdit: true,
        draftId: null,
        validationOk: false,
        publishReady: false,
        busy: false,
        promotionNeedsHumanApproval: false,
      }),
    ).toEqual({
      target: null,
      hasEditableDraft: false,
      showLane: false,
      primaryDisabled: true,
    });

    expect(
      buildHostedIntegrationPublishActionState({
        canEdit: true,
        draftId: "draft_1",
        validationOk: false,
        busy: false,
        promotionNeedsHumanApproval: false,
      }),
    ).toEqual({
      target: {
        kind: "editable_change_set",
        id: "draft_1",
        ownedByCurrentHuman: true,
        ready: true,
      },
      hasEditableDraft: true,
      showLane: true,
      primaryDisabled: false,
    });

    expect(
      buildHostedIntegrationPublishActionState({
        canEdit: true,
        draftId: "draft_1",
        validationOk: true,
        publishReady: false,
        busy: false,
        promotionNeedsHumanApproval: false,
      }).primaryDisabled,
    ).toBe(true);

    expect(
      buildHostedIntegrationPublishActionState({
        canEdit: true,
        draftId: "draft_1",
        validationOk: true,
        publishReady: true,
        busy: false,
        promotionNeedsHumanApproval: true,
      }),
    ).toEqual({
      target: {
        kind: "editable_change_set",
        id: "draft_1",
        ownedByCurrentHuman: true,
        ready: true,
      },
      hasEditableDraft: true,
      showLane: true,
      primaryDisabled: true,
    });
  });

  it("counts only open assigned failure buckets for the repair summary", () => {
    expect(
      countHostedIntegrationAssignedOpenFailureBuckets([
        {
          id: "bucket_open_assigned",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          generationId: "gen_current",
          status: "open",
          count: 1,
          latestSeenAt: "2026-08-12T00:00:00.000Z",
          assignedTo: "tool-developer",
        },
        {
          id: "bucket_open_unassigned",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          generationId: "gen_current",
          status: "open",
          count: 1,
          latestSeenAt: "2026-08-12T00:00:00.000Z",
        },
        {
          id: "bucket_closed_assigned",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          generationId: "gen_previous",
          status: "closed",
          count: 1,
          latestSeenAt: "2026-08-11T00:00:00.000Z",
          assignedTo: "tool-developer",
        },
      ]),
    ).toBe(1);
  });

  it("summarizes failure buckets according to active repair state", () => {
    expect(
      buildHostedIntegrationFailureSummaryState([
        {
          id: "bucket_open_assigned",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          generationId: "gen_current",
          status: "open",
          count: 1,
          latestSeenAt: "2026-08-12T00:00:00.000Z",
          assignedTo: "tool-developer",
        },
        {
          id: "bucket_closed",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          generationId: "gen_previous",
          status: "closed",
          count: 2,
          latestSeenAt: "2026-08-11T00:00:00.000Z",
          assignedTo: "tool-developer",
        },
      ]),
    ).toEqual({
      openCount: 1,
      assignedOpenCount: 1,
      guidance: "Close requires a passing regression proof.",
    });

    expect(
      buildHostedIntegrationFailureSummaryState([
        {
          id: "bucket_closed",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          generationId: "gen_previous",
          status: "closed",
          count: 2,
          latestSeenAt: "2026-08-11T00:00:00.000Z",
          assignedTo: "tool-developer",
        },
      ]),
    ).toEqual({
      openCount: 0,
      assignedOpenCount: 0,
      guidance:
        "No open repair buckets. Historical buckets are listed for audit.",
    });
  });

  it("shows repair assignment only for an actionable failure bucket target", () => {
    const openUnassignedBucket = {
      id: "bucket_open_unassigned",
      familyId: "qualys",
      toolName: "qualys_count_assets",
      generationId: "gen_current",
      status: "open" as const,
      count: 1,
      latestSeenAt: "2026-08-12T00:00:00.000Z",
    };

    expect(
      buildHostedIntegrationFailureBucketActionState({
        bucket: openUnassignedBucket,
        canManage: true,
        assignedRepairActor: "tool-developer",
      }),
    ).toEqual({
      target: {
        kind: "failure_bucket",
        id: "bucket_open_unassigned",
        ownedByCurrentHuman: true,
        ready: true,
      },
      canAssignRepair: true,
    });

    expect(
      buildHostedIntegrationFailureBucketActionState({
        bucket: openUnassignedBucket,
        canManage: false,
        assignedRepairActor: "tool-developer",
      }),
    ).toEqual({
      target: null,
      canAssignRepair: false,
    });

    expect(
      buildHostedIntegrationFailureBucketActionState({
        bucket: {
          ...openUnassignedBucket,
          id: "bucket_open_assigned",
          assignedTo: "tool-developer",
        },
        canManage: true,
        assignedRepairActor: "tool-developer",
      }),
    ).toEqual({
      target: null,
      canAssignRepair: false,
    });

    expect(
      buildHostedIntegrationFailureBucketActionState({
        bucket: {
          ...openUnassignedBucket,
          id: "bucket_closed",
          status: "closed",
        },
        canManage: true,
        assignedRepairActor: "tool-developer",
      }),
    ).toEqual({
      target: null,
      canAssignRepair: false,
    });
  });

  it("builds a single accessible failure bucket row label", () => {
    expect(hostedIntegrationFailureBucketHitLabel(1)).toBe("1 hit");
    expect(hostedIntegrationFailureBucketHitLabel(2)).toBe("2 hits");

    const label = hostedIntegrationFailureBucketAccessibleLabel({
      bucket: {
        id: "bucket_1",
        familyId: "qualys",
        toolName: "qualys_gav_asset_count",
        generationId: "gen_previous",
        status: "closed",
        count: 2,
        latestSeenAt: "2026-08-13T18:50:37.000Z",
        assignedTo: "tool-developer",
      },
      versionRelation: "previous version",
      assignedLabel: "tool-developer",
      latestSeenLabel: "8/13/2026, 9:50:37 PM",
    });

    expect(label).toBe(
      "Failure bucket, qualys_gav_asset_count, previous version, 2 hits, tool-developer, 8/13/2026, 9:50:37 PM, closed",
    );
    expect(label.match(/closed/g)).toHaveLength(1);
    expect(label.match(/2 hits/g)).toHaveLength(1);
  });

  it("labels failure bucket actions with the bucket target", () => {
    expect(
      hostedIntegrationFailureBucketActionAccessibleLabels({
        bucket: {
          id: "bucket_1",
          familyId: "qualys",
          toolName: "qualys_gav_asset_count",
          generationId: "gen_previous",
          status: "open",
          count: 1,
          latestSeenAt: "2026-08-13T18:50:37.000Z",
        },
        versionRelation: "previous version",
      }),
    ).toEqual({
      assignRepair:
        "Assign repair for qualys_gav_asset_count failure bucket, previous version",
    });

    expect(
      hostedIntegrationFailureBucketActionAccessibleLabels({
        bucket: null,
        versionRelation: "",
      }),
    ).toEqual({
      assignRepair:
        "Assign repair for selected tool failure bucket, selected version",
    });
  });

  it("blocks family navigation while another family is being edited", () => {
    expect(
      shouldBlockHostedIntegrationFamilyNavigation({
        editingFamilyId: null,
        targetFamilyId: "qualys",
      }),
    ).toBe(false);
    expect(
      shouldBlockHostedIntegrationFamilyNavigation({
        editingFamilyId: "qualys",
        targetFamilyId: "qualys",
      }),
    ).toBe(false);
    expect(
      shouldBlockHostedIntegrationFamilyNavigation({
        editingFamilyId: "qualys",
        targetFamilyId: "jira",
      }),
    ).toBe(true);
  });

  it("prefers editable source files over metadata files when opening family source", () => {
    expect(
      selectHostedIntegrationEditableSourcePath([
        { path: "examples.yaml" },
        { path: "family.yaml" },
        { path: "qualys.py" },
      ]),
    ).toBe("qualys.py");

    expect(
      selectHostedIntegrationEditableSourcePath([
        { path: "examples.yaml" },
        { path: "family.yaml" },
        { path: "src/index.ts" },
      ]),
    ).toBe("src/index.ts");
  });

  it("labels draft file actions with the current path target", () => {
    expect(
      hostedIntegrationDraftFileActionAccessibleLabels("qualys.py"),
    ).toEqual({
      save: "Save qualys.py",
      delete: "Delete qualys.py",
    });
    expect(hostedIntegrationDraftFileActionAccessibleLabels("   ")).toEqual({
      save: "Save selected file",
      delete: "Delete selected file",
    });

    expect(
      buildHostedIntegrationDraftFileActionState({
        canEdit: true,
        draftId: "draft_1",
        path: "qualys.py",
      }),
    ).toEqual({
      target: {
        kind: "changed_file",
        id: "draft_1:qualys.py",
        ownedByCurrentHuman: true,
        ready: true,
      },
      canSaveFile: true,
      canDeleteFile: true,
    });

    expect(
      buildHostedIntegrationDraftFileActionState({
        canEdit: false,
        draftId: "draft_1",
        path: "qualys.py",
      }),
    ).toEqual({
      target: null,
      canSaveFile: false,
      canDeleteFile: false,
    });

    expect(
      buildHostedIntegrationDraftFileActionState({
        canEdit: true,
        draftId: "draft_1",
        path: " ",
      }),
    ).toEqual({
      target: null,
      canSaveFile: false,
      canDeleteFile: false,
    });

    expect(
      hostedIntegrationFileModeAccessibleLabel({
        mode: "current",
        familyName: "Qualys",
      }),
    ).toBe("Show current files for Qualys");

    expect(
      hostedIntegrationFileModeAccessibleLabel({
        mode: "changes",
        familyName: "",
      }),
    ).toBe("Show changed files for selected family");

    expect(
      hostedIntegrationFileEditorAccessibleLabel({
        mode: "current",
        path: "qualys.py",
      }),
    ).toBe("Current source for qualys.py");

    expect(
      hostedIntegrationFileEditorAccessibleLabel({
        mode: "changes",
        path: "",
      }),
    ).toBe("Changed source for selected file");

    expect(
      hostedIntegrationFileEmptyStateText({
        state: "current_empty",
        familyName: "Qualys",
      }),
    ).toBe("No current files found for Qualys.");

    expect(
      hostedIntegrationFileEmptyStateText({
        state: "changes_locked",
        familyName: "Qualys",
      }),
    ).toBe("Select Edit to update files for Qualys.");

    expect(
      hostedIntegrationFileEmptyStateText({
        state: "changes_empty",
        familyName: "",
      }),
    ).toBe("No changed files for selected family yet.");
  });

  it("labels example actions with the selected example target", () => {
    expect(
      hostedIntegrationExampleActionAccessibleLabels(
        "qualys_gav_asset_count_source_backed",
      ),
    ).toEqual({
      save: "Save example qualys_gav_asset_count_source_backed",
      run: "Run test for example qualys_gav_asset_count_source_backed",
    });
    expect(hostedIntegrationExampleActionAccessibleLabels("")).toEqual({
      save: "Save example selected example",
      run: "Run test for example selected example",
    });

    expect(
      hostedIntegrationExamplePayloadAccessibleLabel({
        exampleId: "qualys_gav_asset_count_source_backed",
        mode: "published",
      }),
    ).toBe(
      "Published example payload for qualys_gav_asset_count_source_backed",
    );

    expect(
      hostedIntegrationExamplePayloadAccessibleLabel({
        exampleId: "qualys_gav_asset_count_source_backed",
        mode: "saved",
      }),
    ).toBe("Example payload for qualys_gav_asset_count_source_backed");

    expect(
      hostedIntegrationExamplePayloadAccessibleLabel({
        exampleId: "",
        mode: "new",
      }),
    ).toBe("New example payload for selected example");

    expect(
      hostedIntegrationExampleEmptyStateText({
        mode: "published",
        toolName: "qualys_gav_asset_count",
      }),
    ).toBe("No published examples for qualys_gav_asset_count.");

    expect(
      hostedIntegrationExampleEmptyStateText({
        mode: "saved",
        toolName: "",
      }),
    ).toBe("No saved examples for selected tool.");

    expect(
      hostedIntegrationExampleResultAccessibleLabel(
        "qualys_gav_asset_count_source_backed",
      ),
    ).toBe("Test result for example qualys_gav_asset_count_source_backed");

    expect(hostedIntegrationExampleResultAccessibleLabel("")).toBe(
      "Test result for example selected example",
    );

    expect(
      hostedIntegrationExampleSelectorAccessibleLabel("qualys_gav_asset_count"),
    ).toBe("Select test example for qualys_gav_asset_count");

    expect(hostedIntegrationExampleSelectorAccessibleLabel("")).toBe(
      "Select test example for selected tool",
    );
  });

  it("labels debug actions with the selected tool and environment config targets", () => {
    expect(
      hostedIntegrationDebugActionAccessibleLabel({
        toolName: "qualys_gav_asset_count",
        environmentConfigId: "qualys-test_debug",
      }),
    ).toBe("Run debug for qualys_gav_asset_count using qualys-test_debug");

    expect(
      hostedIntegrationDebugActionAccessibleLabel({
        toolName: "",
        environmentConfigId: null,
      }),
    ).toBe("Run debug for selected tool using selected environment config");

    expect(
      hostedIntegrationDebugEnvironmentConfigAccessibleLabel(
        "qualys_gav_asset_count",
      ),
    ).toBe("Select debug environment config for qualys_gav_asset_count");

    expect(hostedIntegrationDebugEnvironmentConfigAccessibleLabel("")).toBe(
      "Select debug environment config for selected tool",
    );

    expect(
      hostedIntegrationDebugArgumentsAccessibleLabel("qualys_gav_asset_count"),
    ).toBe("Debug arguments for qualys_gav_asset_count");

    expect(hostedIntegrationDebugArgumentsAccessibleLabel("")).toBe(
      "Debug arguments for selected tool",
    );

    expect(
      hostedIntegrationDebugResultAccessibleLabel({
        toolName: "qualys_gav_asset_count",
        environmentConfigId: "qualys-test_debug",
      }),
    ).toBe("Debug result for qualys_gav_asset_count using qualys-test_debug");

    expect(
      hostedIntegrationDebugResultAccessibleLabel({
        toolName: "",
        environmentConfigId: null,
      }),
    ).toBe("Debug result for selected tool using selected environment config");

    expect(
      hostedIntegrationDebugUnavailableReason({
        canManage: true,
        toolName: "",
        operation: null,
        environmentConfigCount: 1,
        requiresEnvironmentConfig: true,
        familyName: "Qualys",
      }),
    ).toBe("Select a tool before running debug.");

    expect(
      hostedIntegrationDebugUnavailableReason({
        canManage: false,
        toolName: "qualys_gav_asset_count",
        operation: "read",
        environmentConfigCount: 1,
        requiresEnvironmentConfig: true,
        familyName: "Qualys",
      }),
    ).toBe(
      "Hosted integration management permission is required to run debug for qualys_gav_asset_count.",
    );

    expect(
      hostedIntegrationDebugUnavailableReason({
        canManage: true,
        toolName: "qualys_update_asset",
        operation: "write",
        environmentConfigCount: 1,
        requiresEnvironmentConfig: true,
        familyName: "Qualys",
      }),
    ).toBe(
      "qualys_update_asset is classified as write. Debug runs are available for read tools only.",
    );

    expect(
      hostedIntegrationDebugUnavailableReason({
        canManage: true,
        toolName: "qualys_gav_asset_count",
        operation: "read",
        environmentConfigCount: 0,
        requiresEnvironmentConfig: true,
        familyName: "Qualys",
      }),
    ).toBe(
      "Add an environment config for Qualys before running debug for qualys_gav_asset_count.",
    );

    expect(
      hostedIntegrationDebugUnavailableReason({
        canManage: true,
        toolName: "qualys_gav_asset_count",
        operation: "read",
        environmentConfigCount: 0,
        requiresEnvironmentConfig: false,
        familyName: "Qualys",
      }),
    ).toBeNull();

    expect(
      hostedIntegrationDebugUnavailableReason({
        canManage: true,
        toolName: "qualys_gav_asset_count",
        operation: "read",
        environmentConfigCount: 1,
        requiresEnvironmentConfig: true,
        familyName: "Qualys",
      }),
    ).toBeNull();
  });

  it("labels environment configs and write-only secret controls", () => {
    expect(
      hostedIntegrationEnvironmentConfigAccessibleLabel({
        environmentConfigId: "qualys-test_debug",
        environment: "test_debug",
        configKeyCount: 1,
        configuredSecretCount: 1,
        secretKeyCount: 2,
      }),
    ).toBe(
      "Environment config qualys-test_debug, test_debug, 1 config keys, 1 configured secrets, 1 missing secrets",
    );

    expect(
      hostedIntegrationEnvironmentConfigAccessibleLabel({
        environmentConfigId: "",
        environment: "",
        configKeyCount: 0,
        configuredSecretCount: 0,
        secretKeyCount: 0,
      }),
    ).toBe(
      "Environment config selected environment config, environment, 0 config keys, 0 configured secrets, 0 missing secrets",
    );

    expect(hostedIntegrationSecretStatusLabel(true)).toBe("configured");
    expect(hostedIntegrationSecretStatusLabel(false)).toBe("missing");

    expect(
      hostedIntegrationSecretInputAccessibleLabel({
        environmentConfigId: "qualys-test_debug",
        secretName: "QUALYS_PASSWORD",
      }),
    ).toBe("New value for secret QUALYS_PASSWORD in qualys-test_debug");

    expect(
      hostedIntegrationSecretActionAccessibleLabel({
        environmentConfigId: "qualys-test_debug",
        secretName: "QUALYS_PASSWORD",
      }),
    ).toBe("Set secret QUALYS_PASSWORD for qualys-test_debug");

    expect(
      hostedIntegrationConfigEmptyStateText({
        familyName: "Qualys",
      }),
    ).toBe("No environment configs defined for Qualys.");
  });

  it("shows debug run only for a read-safe tool and environment config target", () => {
    expect(
      buildHostedIntegrationDebugActionState({
        canManage: true,
        toolName: "qualys_gav_asset_count",
        environmentConfigId: "qualys-test_debug",
        requiresEnvironmentConfig: true,
        operation: "read",
        hasLocalArgumentError: false,
        busy: false,
      }),
    ).toEqual({
      target: {
        kind: "debug_run",
        id: "qualys_gav_asset_count:qualys-test_debug",
        ownedByCurrentHuman: true,
        ready: true,
      },
      canRunDebug: true,
      primaryDisabled: false,
    });

    expect(
      buildHostedIntegrationDebugActionState({
        canManage: true,
        toolName: "qualys_gav_asset_count",
        environmentConfigId: "qualys-test_debug",
        requiresEnvironmentConfig: true,
        operation: "read",
        hasLocalArgumentError: true,
        busy: false,
      }),
    ).toEqual({
      target: {
        kind: "debug_run",
        id: "qualys_gav_asset_count:qualys-test_debug",
        ownedByCurrentHuman: true,
        ready: true,
      },
      canRunDebug: true,
      primaryDisabled: true,
    });

    expect(
      buildHostedIntegrationDebugActionState({
        canManage: true,
        toolName: "qualys_update_asset",
        environmentConfigId: "qualys-test_debug",
        requiresEnvironmentConfig: true,
        operation: "write",
        hasLocalArgumentError: false,
        busy: false,
      }),
    ).toEqual({
      target: null,
      canRunDebug: false,
      primaryDisabled: true,
    });

    expect(
      buildHostedIntegrationDebugActionState({
        canManage: true,
        toolName: "qualys_gav_asset_count",
        environmentConfigId: null,
        requiresEnvironmentConfig: false,
        operation: "read",
        hasLocalArgumentError: false,
        busy: false,
      }),
    ).toEqual({
      target: {
        kind: "debug_run",
        id: "qualys_gav_asset_count:config-free",
        ownedByCurrentHuman: true,
        ready: true,
      },
      canRunDebug: true,
      primaryDisabled: false,
    });
  });

  it("labels tool help actions with the selected tool target", () => {
    expect(
      hostedIntegrationToolHelpActionAccessibleLabels("qualys_gav_asset_count"),
    ).toEqual({
      save: "Save help for qualys_gav_asset_count",
      addParameter: "Add help parameter for qualys_gav_asset_count",
      addExample: "Add help example for qualys_gav_asset_count",
      advancedFields: "Show advanced help fields for qualys_gav_asset_count",
      examplesDisclosure: "Show help examples for qualys_gav_asset_count",
    });
    expect(hostedIntegrationToolHelpActionAccessibleLabels("")).toEqual({
      save: "Save help for selected tool",
      addParameter: "Add help parameter for selected tool",
      addExample: "Add help example for selected tool",
      advancedFields: "Show advanced help fields for selected tool",
      examplesDisclosure: "Show help examples for selected tool",
    });

    expect(
      buildHostedIntegrationToolHelpActionState({
        canEdit: true,
        draftId: "draft_1",
        toolName: "qualys_gav_asset_count",
      }),
    ).toEqual({
      saveTarget: {
        kind: "tool_help",
        id: "draft_1:qualys_gav_asset_count",
        ownedByCurrentHuman: true,
        ready: true,
      },
      canSaveHelp: true,
    });

    expect(
      buildHostedIntegrationToolHelpActionState({
        canEdit: false,
        draftId: "draft_1",
        toolName: "qualys_gav_asset_count",
      }),
    ).toEqual({
      saveTarget: null,
      canSaveHelp: false,
    });

    expect(
      hostedIntegrationToolHelpFieldAccessibleLabels({
        toolName: "qualys_gav_asset_count",
        parameterName: "filter_body",
      }),
    ).toEqual({
      summary: "Help summary for qualys_gav_asset_count",
      full: "Full help detail for qualys_gav_asset_count",
      whenToUse: "When to use help for qualys_gav_asset_count",
      whenNotToUse: "When not to use help for qualys_gav_asset_count",
      noExampleJustification:
        "No example justification for qualys_gav_asset_count",
      parameterRules: "Rules for filter_body in qualys_gav_asset_count",
      parameterFull: "Full detail for filter_body in qualys_gav_asset_count",
      parameterShape:
        "Shape override for filter_body in qualys_gav_asset_count",
    });

    expect(
      hostedIntegrationToolHelpFieldAccessibleLabels({
        toolName: "",
        parameterName: "",
      }).parameterRules,
    ).toBe("Rules for selected parameter in selected tool");

    expect(
      hostedIntegrationToolHelpEmptyStateText({
        state: "summary_empty",
        toolName: "qualys_gav_asset_count",
      }),
    ).toBe("No help summary documented for qualys_gav_asset_count.");

    expect(
      hostedIntegrationToolHelpEmptyStateText({
        state: "parameters_empty",
        toolName: "qualys_gav_asset_count",
      }),
    ).toBe("No parameter help entries documented for qualys_gav_asset_count.");

    expect(
      hostedIntegrationToolHelpEmptyStateText({
        state: "parameter_summary_empty",
        toolName: "qualys_gav_asset_count",
        parameterName: "filter_body",
      }),
    ).toBe("No summary documented for filter_body in qualys_gav_asset_count.");

    expect(
      hostedIntegrationToolHelpEmptyStateText({
        state: "examples_empty",
        toolName: "",
      }),
    ).toBe("No help examples documented for selected tool.");

    expect(
      hostedIntegrationToolHelpParameterRowAccessibleLabels({
        toolName: "qualys_gav_asset_count",
        parameterName: "filter_body",
        parameterIndex: 0,
      }),
    ).toEqual({
      name: "Name for filter_body in qualys_gav_asset_count",
      summary: "Summary for filter_body in qualys_gav_asset_count",
      remove: "Remove filter_body from qualys_gav_asset_count",
    });

    expect(
      hostedIntegrationToolHelpParameterRowAccessibleLabels({
        toolName: "",
        parameterName: "",
        parameterIndex: 1,
      }),
    ).toEqual({
      name: "Name for help parameter 2 in selected tool",
      summary: "Summary for help parameter 2 in selected tool",
      remove: "Remove help parameter 2 from selected tool",
    });

    expect(
      hostedIntegrationToolHelpExampleAccessibleLabels({
        toolName: "qualys_gav_asset_count",
        exampleIndex: 0,
      }),
    ).toEqual({
      payload: "Help example 1 payload for qualys_gav_asset_count",
      remove: "Remove help example 1 for qualys_gav_asset_count",
    });
  });

  it("labels code actions with the selected tool and handler targets", () => {
    expect(
      hostedIntegrationCodeActionAccessibleLabels({
        toolName: "qualys_gav_asset_count",
        handlerName: "tool_qualys_gav_asset_count",
      }),
    ).toEqual({
      editSource: "Edit source file for tool_qualys_gav_asset_count",
      focusedHandler: "Show focused handler for qualys_gav_asset_count",
      fullFamily: "Show full family source for qualys_gav_asset_count",
      schemaDisclosure:
        "Show schema and diagnostics for qualys_gav_asset_count",
      handlerSource: "Handler source for tool_qualys_gav_asset_count",
      schemaDetails: "Schema details for qualys_gav_asset_count",
    });

    expect(
      hostedIntegrationCodeActionAccessibleLabels({
        toolName: "",
        handlerName: null,
      }),
    ).toEqual({
      editSource: "Edit source file for selected handler",
      focusedHandler: "Show focused handler for selected tool",
      fullFamily: "Show full family source for selected tool",
      schemaDisclosure: "Show schema and diagnostics for selected tool",
      handlerSource: "Handler source for selected handler",
      schemaDetails: "Schema details for selected tool",
    });

    expect(
      buildHostedIntegrationCodeActionState({
        canEdit: true,
        draftId: "draft_1",
        path: "qualys.py",
      }),
    ).toEqual({
      editSourceTarget: {
        kind: "source_file",
        id: "draft_1:qualys.py",
        ownedByCurrentHuman: true,
        ready: true,
      },
      canEditSourceFile: true,
    });

    expect(
      buildHostedIntegrationCodeActionState({
        canEdit: true,
        draftId: "draft_1",
        path: "",
      }),
    ).toEqual({
      editSourceTarget: null,
      canEditSourceFile: false,
    });

    expect(
      hostedIntegrationCodeEmptyStateText({
        toolName: "qualys_gav_asset_count",
        handlerName: "tool_qualys_gav_asset_count",
      }),
    ).toBe(
      "No focused source loaded for tool_qualys_gav_asset_count in qualys_gav_asset_count.",
    );

    expect(
      hostedIntegrationCodeEmptyStateText({
        toolName: "",
        handlerName: null,
      }),
    ).toBe("No focused source loaded for selected handler in selected tool.");
  });

  it("labels edit lock actions with the selected family target", () => {
    expect(hostedIntegrationEditLockActionAccessibleLabels("Qualys")).toEqual({
      edit: "Edit Qualys",
      unlock: "Unlock Qualys edit session",
      lockedByAnotherEditor: "Qualys is locked by another editor",
    });
    expect(hostedIntegrationEditLockActionAccessibleLabels("")).toEqual({
      edit: "Edit selected family",
      unlock: "Unlock selected family edit session",
      lockedByAnotherEditor: "selected family is locked by another editor",
    });

    expect(hostedIntegrationEditorModeLabel({ hasDraft: false })).toBe(
      "Inspect mode",
    );
    expect(hostedIntegrationEditorModeLabel({ hasDraft: true })).toBe(
      "Changes",
    );
  });

  it("labels navigation and refresh actions with concrete targets", () => {
    expect(hostedIntegrationRefreshActionAccessibleLabel("hosted tools")).toBe(
      "Refresh hosted tools",
    );
    expect(hostedIntegrationRefreshActionAccessibleLabel("")).toBe(
      "Refresh current view",
    );

    expect(
      hostedIntegrationFamilyNavigationAccessibleLabel({
        familyName: "Qualys",
        familyId: "qualys",
        status: "active",
        includeFamilyId: false,
      }),
    ).toBe("Select family Qualys, active");

    expect(
      hostedIntegrationFamilyNavigationAccessibleLabel({
        familyName: "Qualys",
        familyId: "qualys-prod",
        status: "idle",
        includeFamilyId: true,
      }),
    ).toBe("Select family Qualys (qualys-prod), idle");

    expect(
      hostedIntegrationToolNavigationAccessibleLabel({
        toolName: "qualys_gav_asset_count",
        familyName: "Qualys",
      }),
    ).toBe("Select tool qualys_gav_asset_count in Qualys");

    expect(
      hostedIntegrationToolNavigationAccessibleLabel({
        toolName: "",
        familyName: "",
      }),
    ).toBe("Select tool selected tool");

    expect(
      hostedIntegrationEditorSectionAccessibleLabel({
        sectionLabel: "Code",
        toolName: "qualys_gav_asset_count",
      }),
    ).toBe("Show Code for qualys_gav_asset_count");

    expect(
      hostedIntegrationEditorSectionAccessibleLabel({
        sectionLabel: "",
        toolName: "",
      }),
    ).toBe("Show workspace for selected tool");

    expect(
      hostedIntegrationFileNavigationAccessibleLabel({
        path: "qualys.py",
        sizeBytes: 34726,
        mode: "current",
      }),
    ).toBe("Select current file qualys.py, 34726 bytes");

    expect(
      hostedIntegrationFileNavigationAccessibleLabel({
        path: "",
        sizeBytes: null,
        mode: "changes",
      }),
    ).toBe("Select changes file selected file, size not recorded");

    expect(
      hostedIntegrationLogScopeAccessibleLabel({
        scope: "selected_tool",
        toolName: "qualys_gav_asset_count",
        familyName: "Qualys",
      }),
    ).toBe("Show logs for tool qualys_gav_asset_count");

    expect(
      hostedIntegrationLogScopeAccessibleLabel({
        scope: "family",
        toolName: "qualys_gav_asset_count",
        familyName: "Qualys",
      }),
    ).toBe("Show logs for family Qualys");

    expect(
      hostedIntegrationRefreshLogsAccessibleLabel({
        scope: "selected_tool",
        toolName: "qualys_gav_asset_count",
        familyName: "Qualys",
      }),
    ).toBe("Refresh logs for tool qualys_gav_asset_count");

    expect(
      hostedIntegrationRefreshLogsAccessibleLabel({
        scope: "family",
        toolName: "",
        familyName: "",
      }),
    ).toBe("Refresh logs for family selected family");
  });

  it("exposes package import and export actions only for valid lifecycle targets", () => {
    expect(
      buildHostedIntegrationPackageActionState({
        canManage: true,
        familyId: "qualys",
        activeGenerationId: "gen_1",
        draftId: null,
        lock: null,
        actorId: "web-settings",
        busy: false,
      }),
    ).toMatchObject({
      canImportCreate: true,
      canImportUpdate: false,
      canExportActiveGeneration: true,
      canExportDraft: false,
      canExportCurrentSource: true,
      updateBlockedReason:
        "Lock for editing before importing over this family.",
    });

    expect(
      buildHostedIntegrationPackageActionState({
        canManage: true,
        familyId: "qualys",
        activeGenerationId: "gen_1",
        draftId: "draft_1",
        lock: {
          id: "lock_1",
          familyId: "qualys",
          lockedBy: "web-settings",
          expiresAt: "2026-08-17T00:30:00.000Z",
          draftId: "draft_1",
        },
        actorId: "web-settings",
        busy: false,
      }),
    ).toMatchObject({
      importUpdateTarget: {
        kind: "hosted_package_import_update",
        id: "qualys:draft_1",
      },
      exportDraftTarget: {
        kind: "hosted_package_export_draft",
        id: "draft_1",
      },
      canImportCreate: true,
      canImportUpdate: true,
      canExportActiveGeneration: true,
      canExportDraft: true,
      canExportCurrentSource: true,
      updateBlockedReason: null,
    });

    expect(
      buildHostedIntegrationPackageActionState({
        canManage: true,
        familyId: "qualys",
        activeGenerationId: "gen_1",
        draftId: "draft_1",
        lock: {
          id: "lock_1",
          familyId: "qualys",
          lockedBy: "agent:tool-developer",
          expiresAt: "2026-08-17T00:30:00.000Z",
          draftId: "draft_1",
        },
        actorId: "web-settings",
        busy: false,
      }),
    ).toMatchObject({
      canImportUpdate: false,
      canExportDraft: false,
      updateBlockedReason: "Unlock is held by another editor.",
    });
  });

  it("labels package actions with a concrete family target", () => {
    expect(hostedIntegrationPackageActionAccessibleLabels("Qualys")).toEqual({
      openPanel: "Show package import and export for Qualys",
      closePanel: "Hide package import and export for Qualys",
      importCreate: "Import package as a new hosted tool family",
      importUpdate: "Import package into Qualys pending changes",
      exportActiveGeneration: "Export current version package for Qualys",
      exportDraft: "Export pending changes package for Qualys",
      exportCurrentSource: "Export source package for Qualys",
      copyExport: "Copy exported package for Qualys",
      importPayload: "Hosted family package JSON to import",
      exportPayload: "Exported hosted family package JSON for Qualys",
    });
  });

  it("previews hosted package import contents before creating or updating a draft", () => {
    const preview = buildHostedIntegrationPackagePreviewState({
      mode: "update",
      currentFilePaths: ["family.yaml", "tools.yaml", "old.py"],
      packageJson: JSON.stringify({
        kind: "openacme.hostedFamilyPackage",
        version: 1,
        metadata: { familyId: "qualys" },
        files: [
          {
            path: "family.yaml",
            content:
              "id: qualys\nname: Qualys\nversion: 1\nruntime:\n  entrypoint: qualys.py\n",
          },
          {
            path: "tools.yaml",
            content: [
              "kind: openacme.hostedToolFamily",
              "version: 1",
              "family:",
              "  id: qualys",
              "tools:",
              "  - mcp:",
              "      name: hosted_qualys__qualys_count_assets",
              "      title: Count assets",
              "      description: Count Qualys assets.",
              "      inputSchema: { type: object, additionalProperties: false }",
              "      outputSchema: { type: object, additionalProperties: true }",
              "      annotations: { readOnlyHint: true }",
              "    openacme:",
              "      toolName: qualys_count_assets",
              "      lifecycle: active",
              "      classification:",
              "        operation: read",
              "      fullHelp: help/count.md",
              "      providerRef: { path: provider/qualys.yaml }",
              "      parameterHelp:",
              "        query:",
              "          full: help/query.md",
              "  - mcp:",
              "      name: hosted_qualys__qualys_delete_asset",
              "      title: Delete asset",
              "      description: Delete a Qualys asset.",
              "      inputSchema: { type: object, additionalProperties: false }",
              "      outputSchema: { type: object, additionalProperties: true }",
              "      annotations: { destructiveHint: true }",
              "    openacme:",
              "      toolName: qualys_delete_asset",
              "      lifecycle: active",
              "      classification:",
              "        operation: destructive",
            ].join("\n"),
          },
          {
            path: "examples.yaml",
            content: "examples:\n  - id: smoke\n",
          },
          {
            path: "qualys.py",
            content: "def tool_qualys_count_assets(args, ctx): pass\n",
          },
        ],
      }),
    });

    expect(preview).toMatchObject({
      status: "ready",
      modeLabel: "Update",
      familyId: "qualys",
      familyName: "Qualys",
      toolNames: ["qualys_count_assets", "qualys_delete_asset"],
      fileCount: 4,
      addedFileCount: 2,
      retainedFileCount: 2,
      removedFileCount: 1,
      exampleCount: 1,
      providerRefCount: 1,
      helpRefCount: 2,
      destructiveToolNames: ["qualys_delete_asset"],
    });
  });

  it("marks invalid hosted package preview payloads without throwing", () => {
    expect(
      buildHostedIntegrationPackagePreviewState({
        mode: "create",
        packageJson: "{",
      }),
    ).toMatchObject({
      status: "invalid",
      modeLabel: "Create",
    });
  });

  it("shows example save and run actions only for an editable draft target", () => {
    expect(
      buildHostedIntegrationExampleActionState({
        canEdit: false,
        draftId: "draft_1",
        selectedExampleId: "example_1",
      }),
    ).toEqual({
      saveTarget: null,
      runTarget: null,
      canSaveExample: false,
      canRunExample: false,
    });

    expect(
      buildHostedIntegrationExampleActionState({
        canEdit: true,
        draftId: null,
        selectedExampleId: "example_1",
      }),
    ).toEqual({
      saveTarget: null,
      runTarget: null,
      canSaveExample: false,
      canRunExample: false,
    });

    expect(
      buildHostedIntegrationExampleActionState({
        canEdit: true,
        draftId: "draft_1",
        selectedExampleId: null,
      }),
    ).toEqual({
      saveTarget: {
        kind: "editable_examples",
        id: "draft_1",
        ownedByCurrentHuman: true,
        ready: true,
      },
      canSaveExample: true,
      runTarget: null,
      canRunExample: false,
    });

    expect(
      buildHostedIntegrationExampleActionState({
        canEdit: true,
        draftId: "draft_1",
        selectedExampleId: "example_1",
      }),
    ).toEqual({
      saveTarget: {
        kind: "editable_examples",
        id: "draft_1",
        ownedByCurrentHuman: true,
        ready: true,
      },
      runTarget: {
        kind: "test_example",
        id: "example_1",
        ownedByCurrentHuman: true,
        ready: true,
      },
      canSaveExample: true,
      canRunExample: true,
    });

    expect(
      buildHostedIntegrationExampleActionState({
        canEdit: true,
        draftId: "draft_1",
        selectedExampleId: "example_2",
        selectedExampleCategory: "discovery_required",
      }),
    ).toEqual({
      saveTarget: {
        kind: "editable_examples",
        id: "draft_1",
        ownedByCurrentHuman: true,
        ready: true,
      },
      runTarget: null,
      canSaveExample: true,
      canRunExample: false,
    });
  });
});
