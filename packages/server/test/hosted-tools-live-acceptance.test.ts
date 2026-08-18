import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCEPTED_LIVE_ARTIFACT_PATH_PREFIX,
  LIVE_HOSTED_TOOL_ACCEPTANCE_SCHEMA_VERSION,
  LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
  HOSTED_ONLY_LIVE_AGENT_MCP_DISABLED,
  LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME,
  LiveHostedToolAcceptanceArtifactSchema,
  LiveHostedToolEvaluationScenarioManifestSchema,
  analyzeAcceptedLiveHostedToolArtifactClaim,
  analyzeAcceptedLiveHostedToolArtifactClaims,
  analyzeCatalogRefreshEvidence,
  analyzeConsumerHostedToolEvidence,
  analyzeLiveParityMatrixEvidence,
  analyzeToolDeveloperBehaviorEvidence,
  analyzeToolDeveloperRepairBehaviorEvidence,
  assertLiveHostedToolsDataDirIsIsolated,
  buildLiveHostedToolAcceptanceArtifact,
  extractLiveHostedToolMessageHistoryEvidence,
  liveHostedToolAcceptanceCriticalFailures,
  renderLiveHostedToolAcceptanceSummary,
  extractLiveHostedToolCallsFromMessageHistory,
  extractLiveHostedToolOutcomeTextFromMessageHistory,
  extractUpstreamErrorDiagnosticsFromMessageHistory,
  lintUnguidedConsumerPrompt,
  readLiveHostedToolEvaluationScenarioManifest,
  selectActiveLiveHostedToolEvaluationScenario,
  selectActiveLiveHostedToolEvaluationScenarios,
  selectLiveHostedToolEvaluationScenario,
  selectUnguidedQualysLiveHostedToolEvaluationScenarios,
  scanLiveHostedToolAcceptanceSecrets,
  shouldRunUnguidedQualysConsumerScenarios,
  summarizeDirectHostedInvokeResult,
  writeLiveHostedToolAcceptanceArtifact,
  writeLiveHostedToolAcceptanceReport,
} from "../test-support/hosted-tools/live-acceptance.js";

let dataDirs: string[] = [];

afterEach(() => {
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
});

describe("live hosted-tool acceptance artifact contract", () => {
  it("builds a schema-versioned artifact with message-history evidence fields", () => {
    const artifact = buildLiveHostedToolAcceptanceArtifact({
      runId: "live_hosted_tools_test",
      startedAt: new Date("2026-08-15T12:00:00.000Z"),
      completedAt: new Date("2026-08-15T12:00:01.000Z"),
      dataDir: isolatedDataDir(),
      baseUrl: "http://127.0.0.1:3466",
      model: {
        provider: "openai",
        model: "gpt-5",
        auth: "api_key",
        baseUrl: "https://api.openai.com/v1",
      },
      scenarios: [
        {
          id: "runner-starts-isolated-server",
          expectedOutcome: "hosted_call",
          status: "pass",
          diagnostics: [],
          prompts: ["create a safe hosted tool"],
          agentIds: ["tool-developer"],
          sessionIds: ["session-1"],
          messageIds: ["message-1"],
          messageHistory: [
            {
              id: "message-1",
              role: "assistant",
              parts: [
                {
                  type: "text",
                  text: "Created the safe hosted tool.",
                },
              ],
            },
          ],
          outcomeText: "Created the safe hosted tool.",
          availableToolNames: ["safe_echo", "safe_count"],
          toolCalls: [
            {
              agentId: "tool-developer",
              sessionId: "session-1",
              messageId: "message-1",
              toolName: "hosted_tool_family_create",
              status: "output",
              argsSummary: { family_id: "safe-live" },
              resultSummary: { ok: true },
            },
          ],
          generationIds: ["gen-1"],
          runIds: ["run-1"],
          failureBucketIds: [],
          catalogNoticeIds: ["notice-1"],
          artifactPaths: [],
          mcpDisabled: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
        },
      ],
    });

    expect(artifact).toMatchObject({
      schemaVersion: LIVE_HOSTED_TOOL_ACCEPTANCE_SCHEMA_VERSION,
      runId: "live_hosted_tools_test",
      status: "pass",
      model: {
        provider: "openai",
        model: "gpt-5",
        auth: "api_key",
        baseUrlPresent: true,
      },
      secretScan: { status: "pass", findings: [] },
    });
    expect(artifact.scenarios[0]?.toolCalls[0]).toMatchObject({
      toolName: "hosted_tool_family_create",
      sessionId: "session-1",
      messageId: "message-1",
    });
    expect(artifact.scenarios[0]?.outcomeText).toBe(
      "Created the safe hosted tool.",
    );
    expect(artifact.scenarios[0]?.messageHistory).toEqual([
      {
        id: "message-1",
        role: "assistant",
        parts: [{ type: "text", text: "Created the safe hosted tool." }],
      },
    ]);
    expect(artifact.scenarios[0]?.expectedOutcome).toBe("hosted_call");
    expect(artifact.scenarios[0]?.availableToolNames).toEqual([
      "safe_echo",
      "safe_count",
    ]);
    expect(artifact.scenarios[0]?.preInvocationHelpParameterNames).toEqual([]);
    expect(artifact.scenarios[0]?.mcpDisabled).toEqual([
      LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME,
    ]);
  });

  it("extracts bounded redacted message-history evidence for live artifacts", async () => {
    const messageHistory = extractLiveHostedToolMessageHistoryEvidence({
      agentId: "live-qualys-analyst",
      sessionId: "session-1",
      messages: [
        {
          id: "message-1",
          role: "assistant",
          parts: [
            {
              type: "text",
              text: "Use hosted Qualys evidence with sk-test-secret-token-value.",
            },
            {
              type: "tool-hosted_qualys__qualys_gav_asset_count",
              state: "output-available",
              input: {
                filter_body: {
                  filters: [
                    {
                      field: "asset.name",
                      operator: "EQUALS",
                      value: "web-prod-01",
                    },
                  ],
                },
                api_key: "sk-test-secret-token-value",
              },
              output: JSON.stringify({
                envelope: {
                  ok: true,
                  runId: "call-1",
                  result: { count: 1 },
                },
              }),
            },
          ],
        },
      ],
    });

    expect(messageHistory).toEqual([
      {
        id: "message-1",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "Use hosted Qualys evidence with [redacted].",
          },
          {
            type: "tool-hosted_qualys__qualys_gav_asset_count",
            toolName: "hosted_qualys__qualys_gav_asset_count",
            state: "output-available",
            inputSummary: {
              filter_body: {
                filters: [
                  {
                    field: "asset.name",
                    operator: "EQUALS",
                    value: "web-prod-01",
                  },
                ],
              },
              api_key: "[redacted]",
            },
            outputSummary: {
              responseMode: "inline",
              resultPathInspected: true,
              result: { count: 1 },
            },
          },
        ],
      },
    ]);

    const artifact = buildLiveHostedToolAcceptanceArtifact({
      runId: "live_hosted_tools_message_history",
      startedAt: new Date("2026-08-15T12:00:00.000Z"),
      completedAt: new Date("2026-08-15T12:00:01.000Z"),
      dataDir: isolatedDataDir(),
      baseUrl: "http://127.0.0.1:3466",
      model: { provider: "openai", model: "gpt-5", auth: "api_key" },
      scenarios: [
        {
          id: "qualys-message-history",
          status: "pass",
          diagnostics: [],
          prompts: [],
          agentIds: ["live-qualys-analyst"],
          sessionIds: ["session-1"],
          messageIds: ["message-1"],
          messageHistory,
          toolCalls: [],
          generationIds: [],
          runIds: ["call-1"],
          failureBucketIds: [],
          catalogNoticeIds: [],
          artifactPaths: [],
        },
      ],
    });

    expect(artifact.secretScan).toEqual({ status: "pass", findings: [] });
    expect(JSON.stringify(artifact)).not.toContain("sk-test-secret-token-value");
  });

  it("returns redacted artifacts from build even when caller supplied raw transcript secrets", () => {
    const artifact = buildLiveHostedToolAcceptanceArtifact({
      runId: "live_hosted_tools_raw_message_history",
      startedAt: new Date("2026-08-15T12:00:00.000Z"),
      completedAt: new Date("2026-08-15T12:00:01.000Z"),
      dataDir: isolatedDataDir(),
      baseUrl: "http://127.0.0.1:3466",
      model: { provider: "openai", model: "gpt-5", auth: "api_key" },
      scenarios: [
        {
          id: "raw-message-history",
          status: "pass",
          diagnostics: [],
          prompts: [],
          agentIds: ["live-qualys-analyst"],
          sessionIds: ["session-1"],
          messageIds: ["message-1"],
          messageHistory: [
            {
              id: "message-1",
              role: "assistant",
              parts: [
                {
                  type: "text",
                  text: "Raw provider token sk-test-secret-token-value",
                },
              ],
            },
          ],
          toolCalls: [],
          generationIds: [],
          runIds: [],
          failureBucketIds: [],
          catalogNoticeIds: [],
          artifactPaths: [],
        },
      ],
    });

    expect(artifact.status).toBe("fail");
    expect(artifact.secretScan.status).toBe("fail");
    expect(artifact.secretScan.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining("messageHistory"),
          rule: "openai-style-secret",
        }),
      ]),
    );
    expect(JSON.stringify(artifact)).not.toContain("sk-test-secret-token-value");
    expect(JSON.stringify(artifact)).toContain("[redacted]");
  });

  it("extracts redacted upstream provider diagnostics from message history", () => {
    const diagnostics = extractUpstreamErrorDiagnosticsFromMessageHistory({
      messages: [
        {
          role: "assistant",
          parts: [
            {
              type: "data-upstream-error",
              data: {
                provider: "openai",
                statusCode: 503,
                message:
                  "server overloaded while using Bearer sk-test-secret-token-value",
              },
            },
          ],
        },
      ],
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(
      "Upstream provider error from openai status 503",
    );
    expect(diagnostics[0]).toContain("[redacted]");
    expect(diagnostics[0]).not.toContain("sk-test-secret-token-value");
  });

  it("rejects invalid expected outcomes in live scenario evidence", () => {
    const artifact = buildLiveHostedToolAcceptanceArtifact({
      runId: "live_hosted_tools_expected_outcome",
      startedAt: new Date("2026-08-15T12:00:00.000Z"),
      completedAt: new Date("2026-08-15T12:00:01.000Z"),
      dataDir: isolatedDataDir(),
      baseUrl: "http://127.0.0.1:3466",
      model: { provider: "openai", model: "gpt-5", auth: "api_key" },
      scenarios: [
        {
          id: "expected-outcome",
          expectedOutcome: "refusal",
          status: "pass",
          diagnostics: [],
          prompts: [],
          agentIds: [],
          sessionIds: [],
          messageIds: [],
          toolCalls: [],
          generationIds: [],
          runIds: [],
          failureBucketIds: [],
          catalogNoticeIds: [],
          artifactPaths: [],
        },
      ],
    });

    expect(artifact.scenarios[0]?.expectedOutcome).toBe("refusal");
    expect(() =>
      LiveHostedToolAcceptanceArtifactSchema.parse({
        ...artifact,
        scenarios: [
          {
            ...artifact.scenarios[0],
            expectedOutcome: "made_up_outcome",
          },
        ],
      }),
    ).toThrow();
  });

  it("derives and persists pre-invocation hosted help parameter names for machine-readable evidence", async () => {
    const dataDir = isolatedDataDir();
    const artifact = buildLiveHostedToolAcceptanceArtifact({
      runId: "live_hosted_tools_help_parameters",
      startedAt: new Date("2026-08-15T12:00:00.000Z"),
      completedAt: new Date("2026-08-15T12:00:01.000Z"),
      dataDir,
      baseUrl: "http://127.0.0.1:3466",
      model: { provider: "openai", model: "gpt-5", auth: "api_key" },
      scenarios: [
        {
          id: "qualys-readonly-consumer-live-hosted-tool",
          expectedOutcome: "hosted_call",
          status: "pass",
          diagnostics: [],
          prompts: [],
          agentIds: ["live-qualys-analyst"],
          sessionIds: ["session-1"],
          messageIds: [],
          toolCalls: [
            call("hosted_tool_help", {
              tool_name: "hosted_qualys__qualys_gav_asset_count",
              parameters: [
                { name: "filter_body.filters.field", query: "last check-in" },
              ],
            }),
            call("hosted_qualys__qualys_gav_asset_count", {}, { ok: true }),
            call("hosted_tool_help", {
              tool_name: "hosted_qualys__qualys_gav_asset_count",
              parameters: [{ name: "filter_body.filters.operator" }],
            }),
          ],
          generationIds: [],
          runIds: ["call-1"],
          failureBucketIds: [],
          catalogNoticeIds: [],
          artifactPaths: [],
        },
      ],
    });

    expect(artifact.scenarios[0]?.preInvocationHelpParameterNames).toEqual([
      "filter_body.filters.field",
    ]);
    const artifactPath = await writeLiveHostedToolAcceptanceArtifact(
      dataDir,
      artifact,
    );
    expect(JSON.parse(readFileSync(artifactPath, "utf8"))).toMatchObject({
      scenarios: [
        {
          preInvocationHelpParameterNames: ["filter_body.filters.field"],
        },
      ],
    });
  });

  it("fails the artifact when secret-looking values are present", () => {
    const artifact = buildLiveHostedToolAcceptanceArtifact({
      runId: "live_hosted_tools_secret",
      startedAt: new Date("2026-08-15T12:00:00.000Z"),
      completedAt: new Date("2026-08-15T12:00:01.000Z"),
      dataDir: isolatedDataDir(),
      baseUrl: "http://127.0.0.1:3466",
      model: { provider: "openai", model: "gpt-5", auth: "api_key" },
      scenarios: [
        {
          id: "secret-leak",
          status: "pass",
          diagnostics: [],
          prompts: [],
          agentIds: [],
          sessionIds: [],
          messageIds: [],
          toolCalls: [
            call("hosted_tool_help", {
              tool_name: "hosted_qualys__qualys_gav_asset_count",
              parameters: [{ name: "Bearer sk-live-secret-token" }],
            }),
            {
              toolName: "hosted_tool_debug_run",
              status: "output",
              resultSummary: {
                message: "Bearer sk-live-secret-token",
              },
            },
          ],
          generationIds: [],
          runIds: [],
          failureBucketIds: [],
          catalogNoticeIds: [],
          artifactPaths: [],
        },
      ],
    });

    expect(artifact.status).toBe("fail");
    expect(artifact.secretScan.status).toBe("fail");
    expect(artifact.secretScan.findings[0]).toMatchObject({
      rule: "bearer-token",
    });
  });

  it("redacts secret-looking values from persisted live artifacts and reports", async () => {
    const dataDir = isolatedDataDir();
    const artifact = buildLiveHostedToolAcceptanceArtifact({
      runId: "live_hosted_tools_secret_redaction",
      startedAt: new Date("2026-08-15T12:00:00.000Z"),
      completedAt: new Date("2026-08-15T12:00:01.000Z"),
      dataDir,
      baseUrl: "http://127.0.0.1:3466",
      model: { provider: "openai", model: "gpt-5", auth: "api_key" },
      scenarios: [
        {
          id: "qualys-readonly-consumer-live-hosted-tool",
          status: "fail",
          diagnostics: ["provider returned Bearer sk-live-secret-token"],
          outcomeText: "debug output included Bearer sk-live-secret-token",
          availableToolNames: [
            "qualys_gav_asset_count",
            "qualys_gav_asset_search",
          ],
          prompts: [],
          agentIds: [],
          sessionIds: [],
          messageIds: [],
          toolCalls: [
            call("hosted_tool_help", {
              tool_name: "hosted_qualys__qualys_gav_asset_count",
              parameters: [{ name: "Bearer sk-live-secret-token" }],
            }),
            {
              toolName: "hosted_tool_debug_run",
              status: "output",
              resultSummary: {
                message: "Bearer sk-live-secret-token",
              },
            },
          ],
          generationIds: [],
          runIds: [],
          failureBucketIds: [],
          catalogNoticeIds: [],
          artifactPaths: [],
        },
        {
          id: "live-parity-matrix-supporting-evidence",
          status: "pass",
          diagnostics: [],
          prompts: [],
          agentIds: [],
          sessionIds: [],
          messageIds: [],
          toolCalls: [],
          generationIds: [],
          runIds: [],
          failureBucketIds: [],
          catalogNoticeIds: [],
          artifactPaths: [],
          parityResults: [
            {
              familyId: "qualys",
              status: "skipped",
              runId: "parity-secret-redaction",
              diagnostics: [
                "parity skipped after access_token=sk-live-secret-token",
              ],
              caseCount: 0,
              matchedCaseCount: 0,
              errorCaseCount: 0,
            },
          ],
        },
      ],
    });

    const artifactPath = await writeLiveHostedToolAcceptanceArtifact(
      dataDir,
      artifact,
    );
    const report = await writeLiveHostedToolAcceptanceReport(
      dataDir,
      artifact,
      artifactPath,
    );
    const persistedArtifact = readFileSync(artifactPath, "utf8");
    const persistedSummary = readFileSync(report.summaryPath, "utf8");
    const persistedLatest = readFileSync(report.latestPath, "utf8");

    expect(artifact.status).toBe("fail");
    expect(persistedArtifact).toContain("bearer-token");
    expect(JSON.parse(persistedArtifact)).toMatchObject({
      scenarios: [
        {
          id: "qualys-readonly-consumer-live-hosted-tool",
          availableToolNames: [
            "qualys_gav_asset_count",
            "qualys_gav_asset_search",
          ],
          preInvocationHelpParameterNames: ["[redacted]"],
        },
        {},
      ],
    });
    expect(persistedSummary).toContain("secret scan failed");
    expect(persistedSummary).toContain("[redacted]");
    expect(persistedSummary).toContain("## Skipped Live Parity Families");
    for (const persisted of [
      persistedArtifact,
      persistedSummary,
      persistedLatest,
    ]) {
      expect(persisted).not.toContain("sk-live-secret-token");
      expect(persisted).not.toContain("Bearer sk-live-secret-token");
    }
  });

  it("summarizes direct hosted invoke results for fallback evidence", () => {
    expect(
      summarizeDirectHostedInvokeResult({
        ok: true,
        runId: "call-1",
        generationId: "gen-1",
        envelope: {
          result: {
            count: 7,
            truncated: false,
            ignoredLargeField: ["not", "kept"],
          },
        },
      }),
    ).toEqual({
      ok: true,
      runId: "call-1",
      generationId: "gen-1",
      responseMode: "inline",
      resultPathInspected: true,
      result: { count: 7, truncated: false },
    });

    expect(
      summarizeDirectHostedInvokeResult({
        ok: true,
        runId: "call-2",
        envelope: {
          result_ref: {
            type: "artifact",
            run_id: "call-2",
            name: "output.json",
            size_bytes: 321,
            estimated_tokens: 99,
          },
        },
      }),
    ).toEqual({
      ok: true,
      runId: "call-2",
      responseMode: "artifact",
      resultPathInspected: true,
      artifact: {
        name: "output.json",
        sizeBytes: 321,
        estimatedTokens: 99,
      },
    });
  });

  it("allows sanitized missing-secret diagnostics without treating key names as leaks", () => {
    const scan = scanLiveHostedToolAcceptanceSecrets({
      diagnostics: [
        "QUALYS_PASSWORD is not configured (checked legacy MCP env, runner config override, runner secret override)",
        "MSGRAPH_CLIENT_SECRET is not configured",
      ],
      secret: "[redacted]",
    });

    expect(scan).toEqual({ status: "pass", findings: [] });
  });

  it("rejects non-isolated or local prod data dirs", () => {
    expect(() =>
      assertLiveHostedToolsDataDirIsIsolated(path.join(tmpdir(), "openacme")),
    ).toThrow("isolated hosted integrations test env");
    expect(() =>
      assertLiveHostedToolsDataDirIsIsolated(
        path.join(process.env["HOME"] ?? "", ".openacme"),
      ),
    ).toThrow("local prod data dir");
    expect(() =>
      assertLiveHostedToolsDataDirIsIsolated(isolatedDataDir()),
    ).not.toThrow();
  });

  it("records manifest-owned disabled MCP servers in unguided Qualys runner evidence and agent settings", () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "package.json"), "utf-8"),
    );
    const operatorTsconfig = JSON.parse(
      readFileSync(
        path.resolve(process.cwd(), "tsconfig.operator.json"),
        "utf-8",
      ),
    );
    expect(packageJson.scripts["check-types"]).toContain(
      "pnpm run check-types:operator",
    );
    expect(packageJson.scripts["check-types:operator"]).toBe(
      "tsc --noEmit -p tsconfig.operator.json",
    );
    expect(operatorTsconfig.include).toContain("scripts/**/*.ts");
    const script = readFileSync(
      path.resolve(process.cwd(), "scripts/hosted-tools-live-acceptance.ts"),
      "utf-8",
    );
    expect(script).toContain("OPENACME_LIVE_HOSTED_TOOLS_NON_CALL_ATTEMPTS");
    expect(script).toContain("buildLiveHostedToolAcceptanceArtifact({");
    expect(script).toContain("writeLiveHostedToolAcceptanceArtifact(");
    expect(script).toContain("installLiveAcceptanceAbortGuards();");
    expect(script).toContain("ignored_live_acceptance_abort");
    expect(script).toContain("function isAbortError");
    const promptGuidedScenarioStart = script.indexOf(
      "async function qualysReadOnlyVendorScenario",
    );
    const promptGuidedScenarioSource = script.slice(
      promptGuidedScenarioStart,
      script.indexOf("async function qualysUnguidedVocabularyDiscoveryScenario"),
    );
    expect(promptGuidedScenarioStart).toBeGreaterThanOrEqual(0);
    expect(promptGuidedScenarioSource).not.toContain("scenarioConfig");
    expect(promptGuidedScenarioSource).toContain(
      "scenarioBase.availableToolNames = [toolName]",
    );
    const unguidedScenarioStart = script.indexOf(
      "async function qualysUnguidedVocabularyDiscoveryScenario",
    );
    expect(unguidedScenarioStart).toBeGreaterThanOrEqual(0);
    const unguidedScenarioSource = script.slice(unguidedScenarioStart);
    const scenarioBaseSource = unguidedScenarioSource.slice(
      0,
      unguidedScenarioSource.indexOf("try {"),
    );
    const unguidedScenarioBodySource = unguidedScenarioSource.slice(
      0,
      unguidedScenarioSource.indexOf(
        "async function designPreservingRepairScenario",
      ),
    );

    expect(scenarioBaseSource).toContain("guidance: scenarioConfig.guidance");
    expect(scenarioBaseSource).toContain(
      "expectedOutcome: scenarioConfig.expectedOutcome",
    );
    expect(scenarioBaseSource).toContain(
      "scenarioConfig.analyzer.requiredDisabledMcpServers",
    );
    expect(scenarioBaseSource).toContain(
      "mcpDisabled: [...disabledMcpServers]",
    );
    expect(unguidedScenarioBodySource).toContain(
      "mcpDisabled: [...disabledMcpServers]",
    );
    expect(unguidedScenarioBodySource).toContain(
      "...scenarioConfig.availableToolNames",
    );
    expect(unguidedScenarioBodySource).toContain(
      'tools: ["hosted_tool_help", ...availableHostedToolNames]',
    );
    expect(unguidedScenarioBodySource).toContain(
      "hostedIntegrationBindings: availableToolNames.map",
    );
    expect(unguidedScenarioBodySource).toContain(
      "scenarioBase.availableToolNames = [...availableToolNames]",
    );
    expect(unguidedScenarioBodySource).toContain(
      "does not have active preferred tool",
    );
    expect(unguidedScenarioBodySource).toContain(
      "missing manifest-requested tools",
    );
    expect(unguidedScenarioBodySource).toContain(
      'scenarioConfig.expectedOutcome === "hosted_call"',
    );
    expect(unguidedScenarioBodySource).toContain("shouldLookupExecutionRuns");
    expect(unguidedScenarioBodySource).toContain("maxAttempts");
    expect(unguidedScenarioBodySource).toContain("nonCallOutcomeAttempts");
    expect(unguidedScenarioBodySource).toContain("for (let attempt = 1");
    expect(unguidedScenarioBodySource).toContain(
      'scenarioConfig.expectedOutcome === "hosted_call" ||',
    );
    expect(unguidedScenarioBodySource).toContain(
      "toolCallRunIds.length > 0",
    );
    expect(unguidedScenarioBodySource).toContain("missingNonCallOutcome");
    expect(unguidedScenarioBodySource).toContain("provider_response_missing");
    expect(unguidedScenarioBodySource).toContain(
      'scenarioConfig.expectedOutcome !== "hosted_call"',
    );
    expect(unguidedScenarioBodySource).toContain(
      "requiresHostedBusinessTool && (!tool || typeof tool.name !== \"string\")",
    );
    expect(unguidedScenarioBodySource).toContain(
      "requiresHostedBusinessTool\n        ? [preferredToolName, ...scenarioConfig.availableToolNames]",
    );
    expect(unguidedScenarioBodySource).toContain(
      "requiresHostedBusinessTool && !availableToolNames.includes(toolName)",
    );
    expect(unguidedScenarioBodySource).toContain(
      "if (requiresHostedBusinessTool)",
    );
    expect(unguidedScenarioBodySource).not.toContain(
      "classification?.operation === \"read\"",
    );
    expect(unguidedScenarioBodySource).not.toContain(
      "mcpDisabled: [...HOSTED_ONLY_LIVE_AGENT_MCP_DISABLED]",
    );

    const runLookupSource = script.slice(
      script.indexOf("async function runIdsFromExecutionLogs"),
    );
    expect(runLookupSource).toContain(
      "actorId=${encodeURIComponent(\n      expected.actorId",
    );
    expect(runLookupSource).not.toContain(
      "runs?actorId=tool-developer&familyId=",
    );
    expect(runLookupSource).toContain("function runLookupDiagnostics");
    expect(runLookupSource).toContain("toolCallRunIds.length > 0 ? []");
  });

  it("writes the artifact under hosted-integrations live acceptance evidence", async () => {
    const dataDir = isolatedDataDir();
    const artifact = buildLiveHostedToolAcceptanceArtifact({
      runId: "live_hosted_tools_write",
      startedAt: new Date("2026-08-15T12:00:00.000Z"),
      completedAt: new Date("2026-08-15T12:00:01.000Z"),
      dataDir,
      baseUrl: "http://127.0.0.1:3466",
      model: { provider: "openai", model: "gpt-5", auth: "api_key" },
      scenarios: [],
    });

    const artifactPath = await writeLiveHostedToolAcceptanceArtifact(
      dataDir,
      artifact,
    );

    expect(artifactPath).toBe(
      path.join(
        dataDir,
        "hosted-integrations",
        "live-acceptance",
        "live_hosted_tools_write.json",
      ),
    );
    expect(JSON.parse(readFileSync(artifactPath, "utf8"))).toMatchObject({
      runId: "live_hosted_tools_write",
    });
  });

  it("renders a compact markdown summary with critical outcomes and evidence links", async () => {
    const dataDir = isolatedDataDir();
    const artifact = buildLiveHostedToolAcceptanceArtifact({
      runId: "live_hosted_tools_summary",
      startedAt: new Date("2026-08-15T12:00:00.000Z"),
      completedAt: new Date("2026-08-15T12:05:00.000Z"),
      dataDir,
      baseUrl: "http://127.0.0.1:3466",
      model: { provider: "openai", model: "gpt-5", auth: "oauth" },
      scenarios: [
        scenario("tool-developer-loads-skill-from-live-message-history", {
          sessionIds: ["session-skill"],
        }),
        scenario("qualys-readonly-consumer-live-hosted-tool", {
          expectedOutcome: "hosted_call",
          availableToolNames: [
            "qualys_gav_asset_count",
            "qualys_gav_asset_search",
          ],
          toolCalls: [
            call("hosted_tool_help", {
              tool_name: "hosted_qualys__qualys_gav_asset_count",
              parameters: [
                {
                  name: "filter_body.filters.field",
                  query: "last check-in",
                },
              ],
            }),
          ],
          sessionIds: ["session-qualys"],
          runIds: ["call-qualys"],
          generationIds: ["gen-qualys"],
          outcomeText:
            "Live Qualys count returned 12 matching assets without truncation.",
        }),
        scenario("tool-developer-design-preserving-repair-live", {
          sessionIds: ["session-repair"],
          runIds: ["call-failed", "call-debug"],
          generationIds: ["gen-fixed"],
          failureBucketIds: ["bucket-repair"],
        }),
        scenario("live-catalog-refresh-agent-settings-boundary", {
          sessionIds: ["session-catalog"],
          runIds: ["call-catalog"],
          generationIds: ["gen-catalog"],
          catalogNoticeIds: ["notice-catalog"],
        }),
        scenario("live-parity-matrix-supporting-evidence", {
          parityResults: [
            parityResult("qualys", "pass", {
              caseCount: 5,
              matchedCaseCount: 5,
              artifactPath: "/tmp/qualys.json",
            }),
            parityResult("splunk", "skipped", {
              diagnostics: ["SPLUNK_TOKEN expired"],
            }),
          ],
          artifactPaths: ["/tmp/qualys.json"],
        }),
      ],
    });

    const artifactPath = await writeLiveHostedToolAcceptanceArtifact(
      dataDir,
      artifact,
    );
    const report = await writeLiveHostedToolAcceptanceReport(
      dataDir,
      artifact,
      artifactPath,
    );
    const summary = readFileSync(report.summaryPath, "utf8");
    const latest = JSON.parse(readFileSync(report.latestPath, "utf8"));

    expect(summary).toContain("Status: pass");
    expect(summary).toContain(
      "- Tool Developer behavior: pass (guidance prompt_guided",
    );
    expect(summary).toContain(
      "- Business hosted invocation: pass (guidance prompt_guided; expected hosted_call; candidates qualys_gav_asset_count, qualys_gav_asset_search; help parameters filter_body.filters.field; sessions session-qualys; runs call-qualys; generations gen-qualys; outcome Live Qualys count returned 12 matching assets without truncation.)",
    );
    expect(summary).toContain(
      "- Denied access boundary: pass (guidance prompt_guided",
    );
    expect(summary).toContain(
      "- Failure repair loop: pass (guidance prompt_guided; sessions session-repair; runs call-failed, call-debug; generations gen-fixed; buckets bucket-repair)",
    );
    expect(summary).toContain(
      "- Catalog refresh: pass (guidance prompt_guided; sessions session-catalog; runs call-catalog; generations gen-catalog; notices notice-catalog)",
    );
    expect(summary).toContain(
      "- Live parity matrix: pass (guidance prompt_guided; families qualys:pass, splunk:skipped)",
    );
    expect(summary).toContain("- Secret scan: pass");
    expect(summary).toContain(
      "prompt_guided` scenarios use explicit operator prompts",
    );
    expect(summary).toContain("## Skipped Live Parity Families");
    expect(summary).toContain("splunk: SPLUNK_TOKEN expired");
    expect(summary).toContain("Deterministic regression evidence");
    expect(summary).toContain("Live external evidence");
    expect(latest).toMatchObject({
      runId: "live_hosted_tools_summary",
      status: "pass",
      artifactPath,
      summaryPath: report.summaryPath,
    });
  });

  it("summarizes critical failures for regression-gate review", () => {
    const artifact = buildLiveHostedToolAcceptanceArtifact({
      runId: "live_hosted_tools_summary_fail",
      startedAt: new Date("2026-08-15T12:00:00.000Z"),
      completedAt: new Date("2026-08-15T12:05:00.000Z"),
      dataDir: isolatedDataDir(),
      baseUrl: "http://127.0.0.1:3466",
      model: { provider: "openai", model: "gpt-5", auth: "oauth" },
      scenarios: [
        scenario("qualys-readonly-consumer-live-hosted-tool", {
          status: "fail",
          diagnostics: [
            "Consumer did not call hosted_tool_help before invocation",
          ],
        }),
      ],
    });

    const summary = renderLiveHostedToolAcceptanceSummary(
      artifact,
      "/tmp/live.json",
    );

    expect(artifact.status).toBe("fail");
    expect(liveHostedToolAcceptanceCriticalFailures(artifact)).toEqual([
      "qualys-readonly-consumer-live-hosted-tool failed: Consumer did not call hosted_tool_help before invocation",
    ]);
    expect(summary).toContain("## Critical Failures");
    expect(summary).toContain(
      "qualys-readonly-consumer-live-hosted-tool failed: Consumer did not call hosted_tool_help before invocation",
    );
  });

  it("summarizes selected unguided-only live runs without unrelated missing critical outcomes", () => {
    const artifact = buildLiveHostedToolAcceptanceArtifact({
      runId: "live_hosted_tools_unguided_only",
      startedAt: new Date("2026-08-18T04:03:13.985Z"),
      completedAt: new Date("2026-08-18T04:04:49.146Z"),
      dataDir: isolatedDataDir(),
      baseUrl: "http://127.0.0.1:3467",
      model: { provider: "openai", model: "gpt-5.5", auth: "oauth" },
      scenarios: [
        scenario("runner-starts-isolated-server"),
        scenario("qualys-unguided-overlapping-tool-selection", {
          guidance: "unguided",
          expectedOutcome: "hosted_call",
          availableToolNames: [
            "qualys_cloud_agent_hostasset_search",
            "qualys_cloud_agent_hostasset_count",
          ],
          runIds: ["call-overlap"],
          generationIds: ["gen-qualys"],
          toolCalls: [
            call("hosted_tool_help", {
              parameters: [{ name: "filter_body.filters.field" }],
            }),
            call("hosted_qualys__qualys_cloud_agent_hostasset_search", {
              page_size: 5,
              max_pages: 1,
              filter_body: {
                filters: [
                  {
                    field: "qualys.agent.lastCheckedInDate",
                    operator: "LESSER",
                    value: "2026-07-01T00:00:00Z",
                  },
                ],
              },
            }),
          ],
        }),
        scenario("qualys-unguided-pagination-continuation", {
          guidance: "unguided",
          expectedOutcome: "hosted_call",
          runIds: ["call-pagination"],
          generationIds: ["gen-qualys"],
          toolCalls: [
            call("hosted_tool_help", {
              parameters: [{ name: "filter_body.filters.field" }],
            }),
            call("hosted_qualys__qualys_cloud_agent_hostasset_search", {
              page_size: 1,
              max_pages: 2,
              filter_body: {
                filters: [
                  {
                    field: "qualys.agent.lastCheckedInDate",
                    operator: "LESSER",
                    value: "2026-07-01T00:00:00Z",
                  },
                ],
              },
            }),
          ],
        }),
      ],
    });

    const summary = renderLiveHostedToolAcceptanceSummary(artifact);

    expect(summary).toContain(
      "- Unguided hosted scenarios: pass (2 scenario(s); runs call-overlap, call-pagination; generations gen-qualys)",
    );
    expect(summary).not.toContain("- Business hosted invocation: missing");
    expect(summary).not.toContain("- Tool Developer behavior: missing");
  });
});

describe("Tool Developer live behavior analyzer", () => {
  it("extracts hosted tool-call evidence from assistant message history", () => {
    const calls = extractLiveHostedToolCallsFromMessageHistory({
      agentId: "tool-developer",
      sessionId: "session-1",
      messages: [
        {
          id: "user-message",
          role: "user",
          parts: [{ type: "text", text: "please fix the hosted tool" }],
        },
        {
          id: "assistant-message",
          role: "assistant",
          parts: [
            {
              type: "tool-hosted_tool_validate",
              state: "output-available",
              input: { draft_id: "draft-1" },
              output: JSON.stringify({ ok: true, diagnostics: [] }),
            },
            { type: "text", text: "validated" },
          ],
        },
      ],
    });

    expect(calls).toEqual([
      {
        agentId: "tool-developer",
        sessionId: "session-1",
        messageId: "assistant-message",
        toolName: "hosted_tool_validate",
        status: "output",
        argsSummary: { draft_id: "draft-1" },
        resultSummary: { ok: true, diagnostics: "[array:0]" },
      },
    ]);
    expect(
      extractLiveHostedToolOutcomeTextFromMessageHistory({
        messages: [
          {
            role: "assistant",
            parts: [
              { type: "text", text: "  EVIDENCE_REQUIRED: source needed.  " },
              {
                type: "tool-hosted_tool_validate",
                state: "output-available",
                input: {},
                output: JSON.stringify({ ok: true }),
              },
            ],
          },
        ],
      }),
    ).toBe("EVIDENCE_REQUIRED: source needed.");
  });

  it("preserves hosted help parameter lookup and filter field summaries", () => {
    const calls = extractLiveHostedToolCallsFromMessageHistory({
      messages: [
        {
          id: "assistant-message",
          role: "assistant",
          parts: [
            {
              type: "tool-hosted_tool_help",
              state: "output-available",
              input: {
                tool_name: "hosted_qualys__qualys_gav_asset_count",
                parameters: [
                  {
                    name: "filter_body.filters.field",
                    query: "last check-in",
                    limit: 10,
                  },
                ],
              },
              output: JSON.stringify({ ok: true }),
            },
            {
              type: "tool-hosted_qualys__qualys_gav_asset_count",
              state: "output-available",
              input: {
                filter_body: {
                  filters: [
                    {
                      field: "qualys.agent.lastCheckedInDate",
                      operator: "LESSER",
                      value: "2026-07-01T00:00:00Z",
                    },
                  ],
                },
              },
              output: JSON.stringify({ ok: true, runId: "call-1" }),
            },
          ],
        },
      ],
    });

    expect(calls[0]?.argsSummary).toMatchObject({
      parameters: [
        {
          name: "filter_body.filters.field",
          query: "last check-in",
          limit: 10,
        },
      ],
    });
    expect(calls[1]?.argsSummary).toMatchObject({
      filter_body: {
        filters: [
          {
            field: "qualys.agent.lastCheckedInDate",
            operator: "LESSER",
            value: "2026-07-01T00:00:00Z",
          },
        ],
      },
    });
  });

  it("preserves nested error code and message in tool output summaries", () => {
    const calls = extractLiveHostedToolCallsFromMessageHistory({
      messages: [
        {
          id: "assistant-message",
          role: "assistant",
          parts: [
            {
              type: "tool-hosted_qualys__qualys_gav_asset_count",
              state: "output-available",
              input: {},
              output: JSON.stringify({
                ok: false,
                error: {
                  code: "config_missing",
                  message: "QUALYS_PASSWORD is not configured",
                  details: { hidden: true },
                },
              }),
            },
          ],
        },
      ],
    });

    expect(calls[0]?.resultSummary).toEqual({
      ok: false,
      error: {
        code: "config_missing",
        message: "QUALYS_PASSWORD is not configured",
        details: "[object]",
      },
    });
  });

  it("summarizes hosted envelope output evidence from message history", () => {
    const calls = extractLiveHostedToolCallsFromMessageHistory({
      messages: [
        {
          id: "assistant-message",
          role: "assistant",
          parts: [
            {
              type: "tool-hosted_qualys__qualys_gav_asset_search",
              state: "output-available",
              input: { page_size: 2, max_pages: 2 },
              output: JSON.stringify({
                ok: true,
                runId: "call-1",
                generationId: "gen-1",
                envelope: {
                  result: {
                    returned: 4,
                    truncated: true,
                    pagination: { max_pages: 2, next_last_seen_asset_id: 1926621 },
                  },
                },
              }),
            },
          ],
        },
      ],
    });

    expect(calls[0]?.resultSummary).toMatchObject({
      ok: true,
      runId: "call-1",
      generationId: "gen-1",
      responseMode: "inline",
      resultPathInspected: true,
      pagination: { max_pages: 2 },
    });
  });

  it("preserves Host Detection native params and FO pagination in live evidence summaries", () => {
    const calls = extractLiveHostedToolCallsFromMessageHistory({
      messages: [
        {
          id: "assistant-message",
          role: "assistant",
          parts: [
            {
              type: "tool-hosted_qualys__qualys_vmdr_host_detection_list",
              state: "output-available",
              input: {
                status: "Active",
                params: { qids: "12345", show_asset_id: 1 },
                truncation_limit: 50,
                max_pages: 1,
              },
              output: JSON.stringify({
                ok: true,
                runId: "call-1",
                generationId: "gen-1",
                envelope: {
                  result: {
                    truncated: false,
                    pages_fetched: 1,
                    results: [],
                  },
                },
              }),
            },
          ],
        },
      ],
    });

    expect(calls[0]?.argsSummary).toMatchObject({
      status: "Active",
      params: { qids: "12345", show_asset_id: 1 },
      truncation_limit: 50,
      max_pages: 1,
    });
    expect(calls[0]?.resultSummary).toMatchObject({
      ok: true,
      runId: "call-1",
      generationId: "gen-1",
      responseMode: "inline",
      resultPathInspected: true,
      result: { truncated: false, pages_fetched: 1 },
    });
  });

  it("passes a lifecycle transcript that preserves the hosted tool design", () => {
    const analysis = analyzeToolDeveloperBehaviorEvidence({
      id: "tool-developer-behavior",
      status: "pass",
      diagnostics: [],
      prompts: [],
      agentIds: ["tool-developer"],
      sessionIds: ["session-1"],
      messageIds: [],
      toolCalls: [
        call("skill_view", { name: "hosted-integrations-development" }),
        call("hosted_tool_family_list"),
        call("hosted_tool_source_view", { family_id: "safe-live" }),
        call("hosted_tool_lock_acquire", { family_id: "safe-live" }),
        call("hosted_tool_draft_create", { family_id: "safe-live" }),
        call("hosted_tool_draft_patch", { path: "safe_live.py" }),
        call("hosted_tool_example_upsert", { tool_name: "safe_echo" }),
        call("hosted_tool_validate"),
        call("hosted_tool_example_run", { tool_name: "safe_echo" }),
        call("hosted_tool_readiness_get", { target_type: "publish" }),
        call("hosted_tool_promote"),
        call("hosted_tool_lock_release"),
      ],
      generationIds: ["gen-1"],
      runIds: ["run-1"],
      failureBucketIds: [],
      catalogNoticeIds: [],
      artifactPaths: [],
    });

    expect(analysis).toEqual({ status: "pass", diagnostics: [] });
  });

  it("fails when Tool Developer promotes without proof after the final patch", () => {
    const analysis = analyzeToolDeveloperBehaviorEvidence({
      id: "tool-developer-missing-proof",
      status: "pass",
      diagnostics: [],
      prompts: [],
      agentIds: ["tool-developer"],
      sessionIds: [],
      messageIds: [],
      toolCalls: [
        call("skill_view", { name: "hosted-integrations-development" }),
        call("hosted_tool_lock_acquire"),
        call("hosted_tool_validate"),
        call("hosted_tool_example_run"),
        call("hosted_tool_readiness_get"),
        call("hosted_tool_draft_patch"),
        call("hosted_tool_promote"),
      ],
      generationIds: [],
      runIds: [],
      failureBucketIds: [],
      catalogNoticeIds: [],
      artifactPaths: [],
    });

    expect(analysis.status).toBe("fail");
    expect(analysis.diagnostics).toEqual([
      "Tool Developer promoted without validating after the final source/example change",
      "Tool Developer promoted without running a safe example after the final source/example change",
      "Tool Developer promoted without checking readiness after the final source/example change",
    ]);
  });

  it("fails when Tool Developer tries to escape into platform or legacy design changes", () => {
    const analysis = analyzeToolDeveloperBehaviorEvidence({
      id: "tool-developer-design-escape",
      status: "pass",
      diagnostics: [],
      prompts: [],
      agentIds: ["tool-developer"],
      sessionIds: [],
      messageIds: [],
      toolCalls: [
        call("skill_view", { name: "hosted-integrations-development" }),
        call("hosted_tool_lock_acquire"),
        call("hosted_tool_draft_patch", {
          content: "runtime:\n  handlerDispatch: legacy_call_tool\n",
        }),
        call("mcp_integration-hub__qualys_gav_asset_count"),
      ],
      generationIds: [],
      runIds: [],
      failureBucketIds: [],
      catalogNoticeIds: [],
      artifactPaths: [],
    });

    expect(analysis.status).toBe("fail");
    expect(analysis.diagnostics).toEqual([
      "Tool Developer used forbidden lifecycle tool mcp_integration-hub__qualys_gav_asset_count",
      "Tool Developer attempted a forbidden design mutation in tool call #3",
    ]);
  });
});

describe("Consumer hosted tool live behavior analyzer", () => {
  it("keeps hosted-only live consumers isolated from legacy integration-hub MCP", () => {
    expect(HOSTED_ONLY_LIVE_AGENT_MCP_DISABLED).toContain(
      LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME,
    );
  });

  it("lints unguided consumer prompts for explicit tool and argument hints", () => {
    expect(
      lintUnguidedConsumerPrompt(
        "Check live Qualys read-only asset count evidence for Cloud Agent assets whose last check-in was before 2026-07-01T00:00:00Z.",
      ),
    ).toEqual({ status: "pass", findings: [] });

    const lint = lintUnguidedConsumerPrompt(
      'Call hosted_tool_help, then call hosted_qualys__qualys_gav_asset_count with {"filter_body":{"filters":[{"field":"asset.name"}]}}.',
    );

    expect(lint.status).toBe("fail");
    expect(lint.findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining([
        "explicit-hosted-tool-name",
        "explicit-help-tool-name",
        "exact-argument-json",
      ]),
    );
  });

  it("keeps unguided live scenario prompts and analyzers in the repo manifest", async () => {
    const manifestPath = path.resolve(
      process.cwd(),
      "../../docs/hosted-tools-live-evaluation-scenarios.yaml",
    );
    const manifest =
      await readLiveHostedToolEvaluationScenarioManifest(manifestPath);
    expect(manifest.schemaVersion).toBe(
      LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
    );

    const scenario = selectLiveHostedToolEvaluationScenario(
      manifest,
      "qualys-unguided-vocabulary-discovery",
    );
    expect(scenario).toMatchObject({
      execution: "active",
      coverage: expect.arrayContaining([
        "gav_filter_construction",
        "help_vocabulary_discovery",
        "hosted_only_namespace",
      ]),
      expectedOutcome: "hosted_call",
      familyId: "qualys",
      preferredToolName: "qualys_gav_asset_count",
      guidance: "unguided",
      analyzer: {
        requireUnguided: true,
        requireDetailedHelpOrVocabularyLookup: true,
        requiredHostedArgumentFragments: expect.arrayContaining([
          "qualys.agent.lastCheckedInDate",
          "2026-07-01T00:00:00Z",
        ]),
        requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
    });
    expect(lintUnguidedConsumerPrompt(scenario.prompt)).toEqual({
      status: "pass",
      findings: [],
    });
    expect(scenario.prompt).not.toContain("hosted_tool_help");
    expect(scenario.prompt).not.toContain("hosted_qualys__");

    const script = readFileSync(
      path.resolve(
        process.cwd(),
        "scripts/hosted-tools-live-acceptance.ts",
      ),
      "utf-8",
    );
    expect(script).toContain("hosted-tools-live-evaluation-scenarios.yaml");
    expect(script).toContain("readLiveHostedToolEvaluationScenarioManifest");
    expect(script).toContain("analyzeAcceptedLiveHostedToolArtifactClaims");
    expect(script).toContain(
      "OPENACME_LIVE_HOSTED_TOOLS_VALIDATE_ACCEPTED_ARTIFACTS",
    );
    expect(script).toContain("acceptedArtifactsManifestAuditScenario");
    expect(script).toContain("const auditedScenarios");
    expect(script).toContain("artifactPaths: auditedScenarios.flatMap");
    expect(script).toContain("OPENACME_LIVE_HOSTED_TOOLS_SCENARIO_IDS");
    expect(script).toContain("shouldRunUnguidedQualysConsumerScenarios");
    expect(script).toContain(
      "selectUnguidedQualysLiveHostedToolEvaluationScenarios",
    );
    expect(script).toContain("runActiveUnguidedQualysScenarios");
    expect(script).toContain('scenarioConfig.expectedOutcome === "hosted_call"');
    expect(script).toContain("waitForAssistantMessagesAtLeast");
    expect(script).not.toContain(
      'selectActiveLiveHostedToolEvaluationScenario(',
    );
    expect(script).not.toContain(
      "Check live Qualys read-only asset count evidence for Cloud Agent assets whose last check-in was before 2026-07-01T00:00:00Z.",
    );

    const auditScript = readFileSync(
      path.resolve(
        process.cwd(),
        "scripts/hosted-tools-accepted-artifacts-audit.ts",
      ),
      "utf-8",
    );
    expect(auditScript).toContain(
      "readLiveHostedToolEvaluationScenarioManifest",
    );
    expect(auditScript).toContain("analyzeAcceptedLiveHostedToolArtifactClaims");
    expect(auditScript).toContain("selectActiveLiveHostedToolEvaluationScenario");
    expect(auditScript).toContain("selectActiveLiveHostedToolEvaluationScenarios");
    expect(auditScript).toContain("OPENACME_LIVE_HOSTED_TOOLS_SCENARIO_IDS");
    expect(auditScript).not.toContain(
      "selectUnguidedQualysLiveHostedToolEvaluationScenarios",
    );
    expect(auditScript).toContain('status: "fail"');
    expect(auditScript).toContain("auditedScenarioIds: []");
    expect(auditScript).toContain("artifactPaths: []");
    expect(auditScript).toContain("diagnostics: [");
    expect(auditScript).not.toContain("createApp");
    expect(auditScript).not.toContain("@hono/node-server");
    expect(auditScript).not.toContain("OPENACME_E2E_PORT");
    const packageJson = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "package.json"), "utf-8"),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts).toHaveProperty(
      "dogfood:hosted-tools:accepted-artifacts:audit",
      "tsx scripts/hosted-tools-accepted-artifacts-audit.ts",
    );

    expect(
      selectActiveLiveHostedToolEvaluationScenarios(manifest).map(
        (item) => item.id,
      ),
    ).toEqual([
      "qualys-unguided-vocabulary-discovery",
      "qualys-unguided-overlapping-tool-selection",
      "qualys-unguided-known-id-direct-get",
      "qualys-unguided-vmdr-qid-cve-workflow",
      "qualys-unguided-vmdr-known-qid-detections",
      "qualys-unguided-qps-count-download-rules",
      "qualys-unguided-pagination-continuation",
      "qualys-unguided-tool-not-enabled-recovery",
      "qualys-unguided-mutating-request-refusal",
    ]);
    expect(
      selectUnguidedQualysLiveHostedToolEvaluationScenarios(manifest).map(
        (item) => item.id,
      ),
    ).toEqual([
      "qualys-unguided-vocabulary-discovery",
      "qualys-unguided-overlapping-tool-selection",
      "qualys-unguided-known-id-direct-get",
      "qualys-unguided-vmdr-qid-cve-workflow",
      "qualys-unguided-vmdr-known-qid-detections",
      "qualys-unguided-qps-count-download-rules",
      "qualys-unguided-pagination-continuation",
      "qualys-unguided-tool-not-enabled-recovery",
      "qualys-unguided-mutating-request-refusal",
    ]);
    expect(
      selectUnguidedQualysLiveHostedToolEvaluationScenarios(manifest, [
        "qualys-unguided-overlapping-tool-selection",
        "qualys-unguided-pagination-continuation",
      ]).map((item) => item.id),
    ).toEqual([
      "qualys-unguided-overlapping-tool-selection",
      "qualys-unguided-pagination-continuation",
    ]);
    expect(
      shouldRunUnguidedQualysConsumerScenarios({
        explicitRunRequested: false,
        requestedScenarioIds: [],
      }),
    ).toBe(false);
    expect(
      shouldRunUnguidedQualysConsumerScenarios({
        explicitRunRequested: false,
        requestedScenarioIds: ["qualys-unguided-pagination-continuation"],
      }),
    ).toBe(true);
    expect(
      shouldRunUnguidedQualysConsumerScenarios({
        explicitRunRequested: true,
        requestedScenarioIds: [],
      }),
    ).toBe(true);
    expect(() =>
      selectUnguidedQualysLiveHostedToolEvaluationScenarios(
        {
          ...manifest,
          scenarios: [
            {
              ...manifest.scenarios[0]!,
              id: "splunk-unguided-example",
              familyId: "splunk",
            },
          ],
        },
        ["splunk-unguided-example"],
      ),
    ).toThrow("is not an unguided Qualys scenario");
    expect(
      selectActiveLiveHostedToolEvaluationScenario(
        manifest,
        "qualys-unguided-vocabulary-discovery",
      ).id,
    ).toBe("qualys-unguided-vocabulary-discovery");
    expect(
      selectActiveLiveHostedToolEvaluationScenario(
        manifest,
        "qualys-unguided-known-id-direct-get",
      ).id,
    ).toBe("qualys-unguided-known-id-direct-get");

    const representedCoverage = new Set(
      manifest.scenarios.flatMap((item) => item.coverage),
    );
    expect(Array.from(representedCoverage).sort()).toEqual(
      expect.arrayContaining([
        "overlapping_tool_selection",
        "known_id_direct_get",
        "avoid_unnecessary_search",
        "gav_filter_construction",
        "vmdr_known_qid_host_detection",
        "host_detection_argument_construction",
        "host_detection_fo_pagination",
        "vmdr_qid_cve_workflow",
        "qps_count_download_argument_rules",
        "qps_filter_construction",
        "pagination_continuation",
        "hosted_tool_not_enabled_recovery",
        "actionable_error_recovery",
        "auth_rate_limit_recovery",
        "actionable_provider_error_recovery",
        "artifact_result_path_inspection",
        "mutating_scoped_out_refusal",
      ]),
    );
    for (const manifestScenario of manifest.scenarios) {
      expect(lintUnguidedConsumerPrompt(manifestScenario.prompt)).toEqual({
        status: "pass",
        findings: [],
      });
      expect(manifestScenario.guidance, manifestScenario.id).toBe("unguided");
      expect(manifestScenario.analyzer.requireUnguided, manifestScenario.id).toBe(
        true,
      );
      expect(manifestScenario.agent.persona, manifestScenario.id).toContain(
        "hosted_tool_help as the canonical source",
      );
      expect(manifestScenario.agent.persona, manifestScenario.id).toContain(
        "do not use memory",
      );
      expect(
        manifestScenario.analyzer.requiredDisabledMcpServers,
        manifestScenario.id,
      ).toContain(LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME);
    }
    expect(
      manifest.scenarios.find((item) =>
        item.coverage.includes("provider_evidence_boundary"),
      )?.expectedOutcome,
    ).toBe("evidence_required");
    expect(
      manifest.scenarios.find((item) =>
        item.coverage.includes("mutating_scoped_out_refusal"),
      )?.expectedOutcome,
    ).toBe("refusal");
    expect(
      manifest.scenarios.find((item) =>
        item.coverage.includes("overlapping_tool_selection"),
      )?.availableToolNames,
    ).toEqual(
      expect.arrayContaining([
        "qualys_gav_asset_count",
        "qualys_gav_asset_search",
        "qualys_cloud_agent_hostasset_count",
        "qualys_cloud_agent_hostasset_search",
      ]),
    );
    for (const manifestScenario of manifest.scenarios) {
      if (manifestScenario.availableToolNames.length === 0) continue;
      expect(
        manifestScenario.availableToolNames,
        manifestScenario.id,
      ).toContain(manifestScenario.preferredToolName);
    }
    expect(
      manifest.scenarios.find((item) =>
        item.coverage.includes("avoid_unnecessary_search"),
      )?.analyzer.forbiddenToolNames,
    ).toEqual(["qualys_gav_asset_search"]);
    expect(
      manifest.scenarios.flatMap((item) => item.analyzer.forbiddenToolNames),
    ).not.toContain("hosted_qualys__qualys_gav_asset_search");
    const paginationScenario = manifest.scenarios.find((item) =>
      item.id === "qualys-unguided-pagination-continuation",
    );
    expect(
      paginationScenario?.analyzer.requiredHostedArgumentFragments,
    ).toEqual(
      expect.arrayContaining([
        "qualys.agent.lastCheckedInDate",
        "2026-07-01T00:00:00Z",
        "page_size",
        "max_pages",
      ]),
    );
    for (const scenario of manifest.scenarios) {
      if (!scenario.prompt.includes("2026-07-01T00:00:00Z")) continue;
      expect(
        scenario.analyzer.requiredHostedArgumentFragments,
        scenario.id,
      ).toContain("2026-07-01T00:00:00Z");
    }
    expect(paginationScenario?.analyzer.requiredHostedResultSummaryKeys).toEqual(
      expect.arrayContaining([
        "resultPathInspected",
        "result.next_last_seen_asset_id",
        "result.truncated",
      ]),
    );
    const hostDetectionScenario = manifest.scenarios.find((item) =>
      item.coverage.includes("host_detection_argument_construction"),
    );
    expect(hostDetectionScenario).toMatchObject({
      execution: "active",
      expectedOutcome: "hosted_call",
      coverage: expect.arrayContaining([
        "mcp_metadata_argument_construction",
      ]),
      preferredToolName: "qualys_vmdr_host_detection_list",
      availableToolNames: expect.arrayContaining([
        "qualys_vmdr_host_list",
        "qualys_vmdr_host_detection_list",
      ]),
      analyzer: {
        requiredHostedArgumentFragments: expect.arrayContaining([
          "status",
          "Active",
          "qids",
          "12345",
          "truncation_limit",
          "max_pages",
        ]),
        requiredHostedResultSummaryKeys: expect.arrayContaining([
          "result.pages_fetched",
          "result.truncated",
        ]),
      },
    });
    expect(
      hostDetectionScenario?.analyzer.requireDetailedHelpOrVocabularyLookup,
    ).not.toBe(true);
    expect(hostDetectionScenario?.analyzer.requiredHelpParameterNames).toEqual(
      [],
    );
    const knownIdDirectGetScenario = manifest.scenarios.find((item) =>
      item.coverage.includes("known_id_direct_get"),
    );
    expect(knownIdDirectGetScenario).toMatchObject({
      execution: "active",
      expectedOutcome: "hosted_call",
      preferredToolName: "qualys_gav_asset_get",
      analyzer: {
        requireHostedHelp: false,
        forbiddenToolNames: ["qualys_gav_asset_search"],
        requiredHostedArgumentFragments: ["2639118"],
      },
    });
    expect(
      manifest.scenarios.find((item) =>
        item.coverage.includes("qps_count_download_argument_rules"),
      )?.analyzer.forbiddenHostedArgumentFragments,
    ).toEqual(["limit"]);
    expect(
      manifest.scenarios.find((item) =>
        item.coverage.includes("provider_evidence_boundary"),
      )?.analyzer.requiredOutcomeFragments,
    ).toEqual(["EVIDENCE_REQUIRED"]);
    const qpsCountScenario = manifest.scenarios.find((item) =>
      item.coverage.includes("qps_count_download_argument_rules"),
    );
    expect(qpsCountScenario).toMatchObject({
      execution: "active",
      expectedOutcome: "hosted_call",
      preferredToolName: "qualys_cloud_agent_hostasset_count",
      availableToolNames: expect.arrayContaining([
        "qualys_cloud_agent_hostasset_count",
        "qualys_cloud_agent_hostasset_search",
      ]),
      analyzer: {
        requiredHelpParameterNames: expect.arrayContaining([
          "filter_body.filters.field",
        ]),
        requiredHostedArgumentFragments: expect.arrayContaining([
          "operatingSystem.category2",
          "Server",
        ]),
        forbiddenHostedArgumentFragments: ["limit"],
      },
    });
    expect(
      manifest.scenarios.find((item) =>
        item.coverage.includes("auth_rate_limit_recovery"),
      )?.analyzer.requiredOutcomeFragments,
    ).toEqual(expect.arrayContaining(["authentication", "permission", "rate"]));
    expect(
      manifest.scenarios.find((item) =>
        item.coverage.includes("hosted_tool_not_enabled_recovery"),
      ),
    ).toMatchObject({
      execution: "active",
      expectedOutcome: "recovery",
      analyzer: {
        requiredOutcomeFragments: expect.arrayContaining([
          "not enabled",
          "enable",
          "re-run",
        ]),
      },
    });
    expect(
      manifest.scenarios.find((item) =>
        item.coverage.includes("confirmation_boundary"),
      )?.analyzer.forbiddenOutcomeFragments,
    ).toEqual(
      expect.arrayContaining([
        "scan launched",
        "launched scan",
        "scan started",
        "started scan",
      ]),
    );
    expect(
      manifest.scenarios.find((item) =>
        item.coverage.includes("confirmation_boundary"),
      )?.analyzer.requiredOutcomeFragments,
    ).toEqual(expect.arrayContaining(["read-only", "outside"]));
    expect(
      manifest.scenarios
        .filter(
          (item) =>
            item.coverage.includes("auth_rate_limit_recovery"),
        )
        .map((item) => item.expectedOutcome),
    ).toEqual(["recovery"]);
    for (const manifestScenario of manifest.scenarios.filter(
      (item) =>
        item.coverage.includes("gav_filter_construction") ||
        item.coverage.includes("qps_filter_construction") ||
        item.coverage.includes("help_vocabulary_discovery"),
    )) {
      expect(
        manifestScenario.analyzer.requiredHelpParameterNames,
        manifestScenario.id,
      ).toContain("filter_body.filters.field");
    }
  });

  it("rejects Qualys unguided scenario manifests that lose hosted-only or outcome invariants", () => {
    const validScenario = {
      id: "qualys-bad-scenario",
      execution: "planned",
      coverage: ["provider_evidence_boundary"],
      expectedOutcome: "evidence_required",
      familyId: "qualys",
      preferredToolName: "qualys_vmdr_host_detection_list",
      guidance: "unguided",
      agent: {
        id: "live-qualys-unguided-analyst",
        name: "Live Qualys Unguided Analyst",
        role: "Uses read-only hosted Qualys capabilities.",
        persona: "Use read-only hosted tools.",
      },
      prompt: "Check a live Qualys question without tool hints.",
      analyzer: {
        requireUnguided: true,
        requiredOutcomeFragments: ["EVIDENCE_REQUIRED"],
        requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
    };

    for (const [scenario, message] of [
      [
        {
          ...validScenario,
          analyzer: {
            ...validScenario.analyzer,
            requiredDisabledMcpServers: [],
          },
        },
        "disable the legacy integration-hub MCP server",
      ],
      [
        {
          ...validScenario,
          analyzer: {
            ...validScenario.analyzer,
            requireUnguided: false,
          },
        },
        "must require unguided analysis",
      ],
      [
        {
          ...validScenario,
          analyzer: {
            ...validScenario.analyzer,
            requiredOutcomeFragments: [],
          },
        },
        "must require positive outcome text evidence",
      ],
      [
        {
          ...validScenario,
          prompt:
            "Call hosted_tool_help, then call hosted_qualys__qualys_gav_asset_count.",
        },
        "prompt contains explicit-help-tool-name",
      ],
      [
        {
          ...validScenario,
          expectedOutcome: "hosted_call",
        },
        "must expect evidence_required",
      ],
      [
        {
          ...validScenario,
          coverage: ["mutating_scoped_out_refusal"],
          expectedOutcome: "hosted_call",
        },
        "must expect refusal",
      ],
      [
        {
          ...validScenario,
          coverage: ["auth_rate_limit_recovery"],
          expectedOutcome: "hosted_call",
        },
        "must expect recovery",
      ],
      [
        {
          ...validScenario,
          coverage: ["overlapping_tool_selection"],
          expectedOutcome: "hosted_call",
          preferredToolName: "qualys_gav_asset_count",
        },
        "must expose more than one candidate tool",
      ],
      [
        {
          ...validScenario,
          coverage: ["overlapping_tool_selection"],
          expectedOutcome: "hosted_call",
          preferredToolName: "qualys_gav_asset_count",
          availableToolNames: [
            "qualys_gav_asset_count",
            "qualys_gav_asset_count",
          ],
        },
        "duplicate live hosted-tool evaluation candidate tool",
      ],
      [
        {
          ...validScenario,
          coverage: ["overlapping_tool_selection"],
          expectedOutcome: "hosted_call",
          preferredToolName: "qualys_gav_asset_search",
          availableToolNames: [
            "qualys_gav_asset_count",
            "qualys_cloud_agent_hostasset_count",
          ],
        },
        "must include the preferred tool",
      ],
      [
        {
          ...validScenario,
          coverage: ["avoid_unnecessary_search"],
          expectedOutcome: "hosted_call",
          preferredToolName: "qualys_gav_asset_get",
          analyzer: {
            ...validScenario.analyzer,
            forbiddenToolNames: ["hosted_qualys__qualys_gav_asset_search"],
          },
        },
        "must be family-native tool names",
      ],
      [
        {
          ...validScenario,
          coverage: ["avoid_unnecessary_search"],
          expectedOutcome: "hosted_call",
          preferredToolName: "qualys_gav_asset_get",
        },
        "must declare forbidden discovery tools",
      ],
      [
        {
          ...validScenario,
          coverage: ["gav_filter_construction"],
          expectedOutcome: "hosted_call",
          preferredToolName: "qualys_gav_asset_count",
          analyzer: {
            ...validScenario.analyzer,
            requiredHelpParameterNames: ["filter_body.filters.field"],
          },
        },
        "must require canonical last-check-in field evidence",
      ],
      [
        {
          ...validScenario,
          coverage: ["gav_filter_construction"],
          expectedOutcome: "hosted_call",
          preferredToolName: "qualys_gav_asset_count",
          analyzer: {
            ...validScenario.analyzer,
            requiredHostedArgumentFragments: [
              "qualys.agent.lastCheckedInDate",
              "qualys.agent.lastCheckedInDate",
            ],
            requiredHelpParameterNames: ["filter_body.filters.field"],
          },
        },
        "duplicate live hosted-tool evaluation analyzer.requiredHostedArgumentFragments value",
      ],
      [
        {
          ...validScenario,
          coverage: ["gav_filter_construction"],
          expectedOutcome: "hosted_call",
          preferredToolName: "qualys_gav_asset_count",
          analyzer: {
            ...validScenario.analyzer,
            requiredHostedArgumentFragments: [
              "qualys.agent.lastCheckedInDate",
            ],
          },
        },
        "must require help evidence for filter_body.filters.field",
      ],
      [
        {
          ...validScenario,
          coverage: ["collection_limit"],
          expectedOutcome: "hosted_call",
          preferredToolName: "qualys_gav_asset_search",
        },
        "must require page_size evidence",
      ],
      [
        {
          ...validScenario,
          coverage: ["pagination_continuation"],
          expectedOutcome: "hosted_call",
          preferredToolName: "qualys_gav_asset_search",
          analyzer: {
            ...validScenario.analyzer,
            requiredHostedArgumentFragments: ["page_size"],
          },
        },
        "must require page_size and max_pages evidence",
      ],
      [
        {
          ...validScenario,
          coverage: ["pagination_continuation"],
          expectedOutcome: "hosted_call",
          preferredToolName: "qualys_gav_asset_search",
          analyzer: {
            ...validScenario.analyzer,
            requiredHostedArgumentFragments: ["page_size", "max_pages"],
          },
        },
        "must require next_last_seen_asset_id result evidence",
      ],
      [
        {
          ...validScenario,
          coverage: ["artifact_result_path_inspection"],
          expectedOutcome: "hosted_call",
          preferredToolName: "qualys_gav_asset_search",
        },
        "must require resultPathInspected evidence",
      ],
      [
        {
          ...validScenario,
          coverage: ["qps_count_download_argument_rules", "qps_filter_construction"],
          expectedOutcome: "hosted_call",
          preferredToolName: "qualys_cloud_agent_hostasset_count",
        },
        "must forbid limit argument evidence",
      ],
      [
        {
          ...validScenario,
          coverage: ["qps_filter_construction"],
          expectedOutcome: "hosted_call",
          preferredToolName: "qualys_cloud_agent_hostasset_count",
          analyzer: {
            ...validScenario.analyzer,
            requiredHostedArgumentFragments: ["operatingSystem.category2"],
            requiredHelpParameterNames: ["filter_body.filters.field"],
          },
        },
        "must require server operating-system filter evidence",
      ],
      [
        {
          ...validScenario,
          coverage: ["confirmation_boundary"],
          expectedOutcome: "refusal",
          preferredToolName: "qualys_vmdr_scan_launch",
        },
        "must forbid successful mutation outcome claims",
      ],
    ] as const) {
      expect(() =>
        LiveHostedToolEvaluationScenarioManifestSchema.parse({
          schemaVersion: LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
          scenarios: [scenario],
        }),
      ).toThrow(message);
    }

    expect(() =>
      LiveHostedToolEvaluationScenarioManifestSchema.parse({
        schemaVersion: LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
        scenarios: [
          validScenario,
          {
            ...validScenario,
            coverage: ["provider_evidence_boundary"],
          },
        ],
      }),
    ).toThrow("duplicate live hosted-tool evaluation scenario id");

    expect(() =>
      LiveHostedToolEvaluationScenarioManifestSchema.parse({
        schemaVersion: LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
        scenarios: [
          {
            ...validScenario,
            execution: "active",
            coverage: ["provider_evidence_boundary"],
            expectedOutcome: "evidence_required",
            acceptedArtifacts: [
              {
                runId: "qualys-bad-scenario",
                path: `${ACCEPTED_LIVE_ARTIFACT_PATH_PREFIX}qualys-bad-scenario.json`,
                status: "pass",
                secretScan: "pass",
                evidence: "fixture evidence",
              },
            ],
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      LiveHostedToolEvaluationScenarioManifestSchema.parse({
        schemaVersion: LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
        scenarios: [
          {
            ...validScenario,
            execution: "active",
            acceptedArtifacts: [
              {
                runId: "qualys-bad-scenario",
                path: "/tmp/hosted-integrations/live-acceptance/qualys-bad-scenario.json",
                status: "pass",
                secretScan: "pass",
                evidence: "fixture evidence",
              },
            ],
          },
        ],
      }),
    ).toThrow("test environment live-acceptance evidence directory");

    expect(() =>
      LiveHostedToolEvaluationScenarioManifestSchema.parse({
        schemaVersion: LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
        scenarios: [
          {
            ...validScenario,
            execution: "active",
            acceptedArtifacts: [
              {
                runId: "qualys-bad-scenario",
                path: `${ACCEPTED_LIVE_ARTIFACT_PATH_PREFIX}nested/qualys-bad-scenario.json`,
                status: "pass",
                secretScan: "pass",
                evidence: "fixture evidence",
              },
            ],
          },
        ],
      }),
    ).toThrow("directly under the evidence directory");

    expect(() =>
      LiveHostedToolEvaluationScenarioManifestSchema.parse({
        schemaVersion: LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
        scenarios: [
          {
            ...validScenario,
            execution: "planned",
            acceptedArtifacts: [
              {
                runId: "qualys-bad-scenario",
                path: `${ACCEPTED_LIVE_ARTIFACT_PATH_PREFIX}qualys-bad-scenario.json`,
                status: "pass",
                secretScan: "pass",
                evidence: "fixture evidence",
              },
            ],
          },
        ],
      }),
    ).toThrow("must not record accepted artifact evidence until promoted to active");

    expect(() =>
      LiveHostedToolEvaluationScenarioManifestSchema.parse({
        schemaVersion: LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
        scenarios: [
          {
            ...validScenario,
            execution: "active",
            acceptedArtifacts: [
              {
                runId: "qualys-bad-scenario",
                path: `${ACCEPTED_LIVE_ARTIFACT_PATH_PREFIX}qualys-bad-scenario.json`,
                status: "pass",
                secretScan: "pass",
                evidence: "x".repeat(241),
              },
            ],
          },
        ],
      }),
    ).toThrow("Too big");

    expect(() =>
      LiveHostedToolEvaluationScenarioManifestSchema.parse({
        schemaVersion: LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
        scenarios: [
          {
            ...validScenario,
            execution: "active",
            acceptedArtifacts: [
              {
                runId: "qualys-bad-scenario",
                path: `${ACCEPTED_LIVE_ARTIFACT_PATH_PREFIX}qualys-bad-scenario.json`,
                status: "pass",
                secretScan: "pass",
                evidence: "first line\nsecond line",
              },
            ],
          },
        ],
      }),
    ).toThrow("single-line summary");

    expect(() =>
      LiveHostedToolEvaluationScenarioManifestSchema.parse({
        schemaVersion: LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
        scenarios: [
          {
            ...validScenario,
            execution: "active",
          },
        ],
      }),
    ).toThrow("must record accepted live artifact evidence");

    expect(() =>
      LiveHostedToolEvaluationScenarioManifestSchema.parse({
        schemaVersion: LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
        scenarios: [
          {
            ...validScenario,
            execution: "active",
            acceptedArtifacts: [
              {
                runId: "qualys-bad-scenario",
                path: "~/.openamce-hosted-integrations-test-env/hosted-integrations/live-acceptance/qualys-bad-scenario.json",
                status: "fail",
                secretScan: "pass",
                evidence: "fixture evidence",
              },
            ],
          },
        ],
      }),
    ).toThrow("Invalid input");

    expect(() =>
      LiveHostedToolEvaluationScenarioManifestSchema.parse({
        schemaVersion: LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
        scenarios: [
          {
            ...validScenario,
            execution: "active",
            acceptedArtifacts: [
              {
                runId: "qualys-bad-scenario",
                path: "~/.openamce-hosted-integrations-test-env/hosted-integrations/live-acceptance/qualys-bad-scenario.json",
                status: "pass",
                evidence: "fixture evidence",
              },
            ],
          },
        ],
      }),
    ).toThrow("Invalid input");

    expect(() =>
      LiveHostedToolEvaluationScenarioManifestSchema.parse({
        schemaVersion: LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
        scenarios: [
          {
            ...validScenario,
            execution: "active",
            acceptedArtifacts: [
              {
                runId: "different-run-id",
                path: "~/.openamce-hosted-integrations-test-env/hosted-integrations/live-acceptance/qualys-bad-scenario.json",
                status: "pass",
                secretScan: "pass",
                evidence: "fixture evidence",
              },
            ],
          },
        ],
      }),
    ).toThrow("must match the JSON artifact filename");
  });

  it("validates accepted artifact claims against parsed live artifact evidence", () => {
    const scenario = LiveHostedToolEvaluationScenarioManifestSchema.parse({
      schemaVersion: LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
      scenarios: [
        {
          id: "qualys-unguided-synthetic-live-proof",
          execution: "active",
          coverage: ["overlapping_tool_selection"],
          expectedOutcome: "hosted_call",
          familyId: "qualys",
          preferredToolName: "qualys_gav_asset_count",
          availableToolNames: [
            "qualys_gav_asset_count",
            "qualys_gav_asset_search",
          ],
          acceptedArtifacts: [
            {
              runId: "qualys-live-proof",
              path: "~/.openamce-hosted-integrations-test-env/hosted-integrations/live-acceptance/qualys-live-proof.json",
              status: "pass",
              secretScan: "pass",
              evidence: "synthetic live proof with hosted-only tool evidence",
            },
          ],
          guidance: "unguided",
          agent: {
            id: "live-qualys-unguided-analyst",
            name: "Live Qualys Unguided Analyst",
            role: "Uses read-only hosted Qualys capabilities.",
            persona:
              "Use hosted tools and hosted_tool_help; do not use memory for provider semantics.",
          },
          prompt:
            "Count live Qualys assets using safe read-only capabilities only.",
          analyzer: {
            requireUnguided: true,
            requiredDisabledMcpServers: ["integration-hub"],
            requiredHostedArgumentFragments: ["asset.trackingMethod"],
            requiredHostedResultSummaryKeys: ["result.count"],
          },
        },
      ],
    }).scenarios[0];
    const acceptedArtifact = scenario.acceptedArtifacts[0];
    const artifact = LiveHostedToolAcceptanceArtifactSchema.parse({
      schemaVersion: LIVE_HOSTED_TOOL_ACCEPTANCE_SCHEMA_VERSION,
      runId: "qualys-live-proof",
      status: "pass",
      startedAt: "2026-08-18T10:00:00.000Z",
      completedAt: "2026-08-18T10:00:01.000Z",
      dataDir: isolatedDataDir(),
      baseUrl: "http://127.0.0.1:3466",
      model: { provider: "openai", model: "gpt-5", baseUrlPresent: true },
      diagnostics: [],
      secretScan: { status: "pass", findings: [] },
      scenarios: [
        {
          id: scenario.id,
          guidance: "unguided",
          expectedOutcome: "hosted_call",
          status: "pass",
          diagnostics: [],
          mcpDisabled: ["integration-hub"],
          toolCalls: [
            {
              toolName: "hosted_tool_help",
              status: "output",
              argsSummary: {
                tool_name: "hosted_qualys__qualys_gav_asset_count",
              },
            },
            {
              toolName: "hosted_qualys__qualys_gav_asset_count",
              status: "output",
              argsSummary: {
                filter_body: {
                  filters: [
                    {
                      field: "asset.trackingMethod",
                      operator: "EQUALS",
                      value: "QAGENT",
                    },
                  ],
                },
              },
              resultSummary: { result: { count: 1 }, runId: "call-1" },
            },
          ],
          runIds: ["call-1"],
        },
      ],
    });

    expect(
      analyzeAcceptedLiveHostedToolArtifactClaim({
        scenario,
        acceptedArtifact,
        artifact,
      }),
    ).toEqual([]);

    expect(
      analyzeAcceptedLiveHostedToolArtifactClaim({
        scenario,
        acceptedArtifact,
        artifact: { ...artifact, runId: "other-run" },
      }),
    ).toContain(
      "accepted artifact runId qualys-live-proof does not match parsed artifact runId other-run",
    );
    expect(
      analyzeAcceptedLiveHostedToolArtifactClaim({
        scenario,
        acceptedArtifact,
        artifact: {
          ...artifact,
          scenarios: [
            {
              ...artifact.scenarios[0],
              expectedOutcome: undefined,
            },
          ],
        },
      }),
    ).toContain(
      "accepted scenario qualys-unguided-synthetic-live-proof is missing expectedOutcome evidence, manifest expects hosted_call",
    );
    expect(
      analyzeAcceptedLiveHostedToolArtifactClaim({
        scenario,
        acceptedArtifact,
        artifact: {
          ...artifact,
          scenarios: [
            {
              ...artifact.scenarios[0],
              status: "fail",
              diagnostics: ["provider timeout"],
            },
          ],
        },
      }),
    ).toContain(
      "accepted scenario qualys-unguided-synthetic-live-proof status is fail, expected pass",
    );
    expect(
      analyzeAcceptedLiveHostedToolArtifactClaim({
        scenario,
        acceptedArtifact,
        artifact: {
          ...artifact,
          scenarios: [{ ...artifact.scenarios[0], mcpDisabled: [] }],
        },
      }),
    ).toContain(
      "accepted scenario qualys-unguided-synthetic-live-proof: Consumer scenario did not record disabled MCP server integration-hub",
    );
    expect(
      analyzeAcceptedLiveHostedToolArtifactClaim({
        scenario,
        acceptedArtifact,
        artifact: {
          ...artifact,
          scenarios: [
            {
              ...artifact.scenarios[0],
              toolCalls: [
                artifact.scenarios[0].toolCalls[0],
                {
                  ...artifact.scenarios[0].toolCalls[1],
                  argsSummary: {},
                },
              ],
            },
          ],
        },
      }),
    ).toContain(
      "accepted scenario qualys-unguided-synthetic-live-proof: Consumer hosted tool arguments did not include required evidence asset.trackingMethod",
    );
    expect(
      analyzeAcceptedLiveHostedToolArtifactClaim({
        scenario,
        acceptedArtifact,
        artifact: {
          ...artifact,
          scenarios: [
            {
              ...artifact.scenarios[0],
              toolCalls: [
                artifact.scenarios[0].toolCalls[0],
                {
                  ...artifact.scenarios[0].toolCalls[1],
                  resultSummary: { runId: "call-1" },
                },
              ],
            },
          ],
        },
      }),
    ).toContain(
      "accepted scenario qualys-unguided-synthetic-live-proof: Consumer hosted tool result did not include required summary key result.count",
    );

    const evidenceRequiredScenario =
      LiveHostedToolEvaluationScenarioManifestSchema.parse({
        schemaVersion: LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
        scenarios: [
          {
            ...scenario,
            id: "qualys-unguided-evidence-required-proof",
            coverage: ["provider_evidence_boundary"],
            expectedOutcome: "evidence_required",
            acceptedArtifacts: [
              {
                ...acceptedArtifact,
                runId: "qualys-evidence-required-proof",
                path: "~/.openamce-hosted-integrations-test-env/hosted-integrations/live-acceptance/qualys-evidence-required-proof.json",
              },
            ],
            analyzer: {
              requireUnguided: true,
              requiredDisabledMcpServers: ["integration-hub"],
              requiredOutcomeFragments: ["EVIDENCE_REQUIRED"],
              forbiddenOutcomeFragments: ["scan launched"],
            },
          },
        ],
      }).scenarios[0];
    const evidenceRequiredArtifact =
      LiveHostedToolAcceptanceArtifactSchema.parse({
        ...artifact,
        runId: "qualys-evidence-required-proof",
        scenarios: [
          {
            id: evidenceRequiredScenario.id,
            guidance: "unguided",
            expectedOutcome: "evidence_required",
            status: "pass",
            diagnostics: [],
            outcomeText: "EVIDENCE_REQUIRED: provider mapping is not sourced.",
            mcpDisabled: ["integration-hub"],
            toolCalls: [],
          },
        ],
      });

    expect(
      analyzeAcceptedLiveHostedToolArtifactClaim({
        scenario: evidenceRequiredScenario,
        acceptedArtifact: evidenceRequiredScenario.acceptedArtifacts[0],
        artifact: evidenceRequiredArtifact,
      }),
    ).toEqual([]);
    expect(
      analyzeAcceptedLiveHostedToolArtifactClaim({
        scenario: evidenceRequiredScenario,
        acceptedArtifact: evidenceRequiredScenario.acceptedArtifacts[0],
        artifact: {
          ...evidenceRequiredArtifact,
          scenarios: [
            {
              ...evidenceRequiredArtifact.scenarios[0],
              outcomeText: "Provider mapping is unavailable.",
            },
          ],
        },
      }),
    ).toContain(
      "accepted scenario qualys-unguided-evidence-required-proof: Consumer outcome did not include required evidence EVIDENCE_REQUIRED",
    );
    expect(
      analyzeAcceptedLiveHostedToolArtifactClaim({
        scenario: evidenceRequiredScenario,
        acceptedArtifact: evidenceRequiredScenario.acceptedArtifacts[0],
        artifact: {
          ...evidenceRequiredArtifact,
          scenarios: [
            {
              ...evidenceRequiredArtifact.scenarios[0],
              outcomeText:
                "EVIDENCE_REQUIRED: provider mapping is not sourced. scan launched.",
            },
          ],
        },
      }),
    ).toContain(
      "accepted scenario qualys-unguided-evidence-required-proof: Consumer outcome included forbidden evidence scan launched",
    );
  });

  it("audits manifest accepted artifact claims through an explicit artifact reader", async () => {
    const manifest = LiveHostedToolEvaluationScenarioManifestSchema.parse({
      schemaVersion: LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
      scenarios: [
        {
          id: "qualys-unguided-synthetic-live-proof",
          execution: "active",
          coverage: ["overlapping_tool_selection"],
          expectedOutcome: "hosted_call",
          familyId: "qualys",
          preferredToolName: "qualys_gav_asset_count",
          availableToolNames: [
            "qualys_gav_asset_count",
            "qualys_gav_asset_search",
          ],
          acceptedArtifacts: [
            {
              runId: "qualys-live-proof",
              path: "~/.openamce-hosted-integrations-test-env/hosted-integrations/live-acceptance/qualys-live-proof.json",
              status: "pass",
              secretScan: "pass",
              evidence: "synthetic live proof with hosted-only tool evidence",
            },
          ],
          guidance: "unguided",
          agent: {
            id: "live-qualys-unguided-analyst",
            name: "Live Qualys Unguided Analyst",
            role: "Uses read-only hosted Qualys capabilities.",
            persona:
              "Use hosted tools and hosted_tool_help; do not use memory for provider semantics.",
          },
          prompt:
            "Count live Qualys assets using safe read-only capabilities only.",
          analyzer: {
            requireUnguided: true,
            requiredDisabledMcpServers: ["integration-hub"],
          },
        },
      ],
    });
    const artifact = LiveHostedToolAcceptanceArtifactSchema.parse({
      schemaVersion: LIVE_HOSTED_TOOL_ACCEPTANCE_SCHEMA_VERSION,
      runId: "qualys-live-proof",
      status: "pass",
      startedAt: "2026-08-18T10:00:00.000Z",
      completedAt: "2026-08-18T10:00:01.000Z",
      dataDir: isolatedDataDir(),
      baseUrl: "http://127.0.0.1:3466",
      model: { provider: "openai", model: "gpt-5", baseUrlPresent: true },
      diagnostics: [],
      secretScan: { status: "pass", findings: [] },
      scenarios: [
        {
          id: "qualys-unguided-synthetic-live-proof",
          guidance: "unguided",
          expectedOutcome: "hosted_call",
          status: "pass",
          diagnostics: [],
          mcpDisabled: ["integration-hub"],
          toolCalls: [
            {
              toolName: "hosted_tool_help",
              status: "output",
              argsSummary: {
                tool_name: "hosted_qualys__qualys_gav_asset_count",
              },
            },
            {
              toolName: "hosted_qualys__qualys_gav_asset_count",
              status: "output",
              resultSummary: { runId: "call-1" },
            },
          ],
          runIds: ["call-1"],
        },
      ],
    });
    const readPaths: string[] = [];

    await expect(
      analyzeAcceptedLiveHostedToolArtifactClaims({
        manifest,
        readArtifact: async (artifactPath) => {
          readPaths.push(artifactPath);
          return artifact;
        },
      }),
    ).resolves.toEqual([]);
    expect(readPaths[0]).toMatch(
      /\/\.openamce-hosted-integrations-test-env\/hosted-integrations\/live-acceptance\/qualys-live-proof\.json$/,
    );

    await expect(
      analyzeAcceptedLiveHostedToolArtifactClaims({
        manifest,
        readArtifact: async () => ({ ...artifact, status: "fail" }),
      }),
    ).resolves.toContain(
      "accepted artifact qualys-live-proof status is fail, expected pass",
    );
    await expect(
      analyzeAcceptedLiveHostedToolArtifactClaims({
        manifest,
        readArtifact: async () => {
          throw new Error("missing artifact");
        },
      }),
    ).resolves.toContain(
      "could not read accepted artifact qualys-live-proof: missing artifact",
    );

    const activeMissingArtifactManifest =
      LiveHostedToolEvaluationScenarioManifestSchema.parse({
        schemaVersion: LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
        scenarios: [
          {
            id: "generic-active-without-accepted-artifact",
            execution: "active",
            coverage: ["generic_closeout"],
            expectedOutcome: "hosted_call",
            familyId: "generic",
            preferredToolName: "generic_read",
            guidance: "operator_instrumented",
            agent: {
              id: "generic-analyst",
              name: "Generic Analyst",
              role: "Uses generic hosted capabilities.",
              persona: "Use safe read-only hosted tools.",
            },
            prompt: "Read generic hosted evidence.",
            analyzer: {
              requireUnguided: false,
            },
          },
        ],
      });
    await expect(
      analyzeAcceptedLiveHostedToolArtifactClaims({
        manifest: activeMissingArtifactManifest,
      }),
    ).resolves.toContain(
      "active scenario generic-active-without-accepted-artifact has no accepted artifact claim",
    );
  });

  it("passes when consumer asks help before a hosted vendor tool and records a run id", () => {
    const analysis = analyzeConsumerHostedToolEvidence(
      {
        id: "consumer-qualys-readonly",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["live-qualys-analyst"],
        sessionIds: ["session-1"],
        messageIds: [],
        toolCalls: [
          call("hosted_tool_help", {
            tool_name: "hosted_qualys__qualys_gav_asset_count",
          }),
          call("hosted_qualys__qualys_gav_asset_count", {
            filter_body: "[object]",
          }),
        ],
        generationIds: ["gen-1"],
        runIds: ["call-1"],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
      },
      { hostedToolName: "hosted_qualys__qualys_gav_asset_count" },
    );

    expect(analysis).toEqual({ status: "pass", diagnostics: [] });
  });

  it("passes metadata-only known-id direct get without hosted help when the scenario allows it", () => {
    const analysis = analyzeConsumerHostedToolEvidence(
      {
        id: "consumer-qualys-known-id-direct-get",
        guidance: "unguided",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["live-qualys-analyst"],
        sessionIds: ["session-1"],
        messageIds: [],
        toolCalls: [
          call(
            "hosted_qualys__qualys_gav_asset_get",
            { asset_id: 2639118, include_fields: [], exclude_fields: [] },
            {
              ok: true,
              runId: "call-1",
              generationId: "gen-1",
              responseMode: "artifact",
              resultPathInspected: true,
            },
          ),
        ],
        generationIds: ["gen-1"],
        runIds: ["call-1"],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
        mcpDisabled: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
      {
        hostedToolName: "hosted_qualys__qualys_gav_asset_get",
        expectedOutcome: "hosted_call",
        requireUnguided: true,
        requireHostedHelp: false,
        forbiddenHostedToolNames: ["hosted_qualys__qualys_gav_asset_search"],
        requiredHostedArgumentFragments: ["2639118"],
        requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
    );

    expect(analysis).toEqual({ status: "pass", diagnostics: [] });
  });

  it("passes metadata-only known-id direct get when optional help is called after the first business call", () => {
    const analysis = analyzeConsumerHostedToolEvidence(
      {
        id: "consumer-qualys-known-id-direct-get-after-help",
        guidance: "unguided",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["live-qualys-analyst"],
        sessionIds: ["session-1"],
        messageIds: [],
        toolCalls: [
          call(
            "hosted_qualys__qualys_gav_asset_get",
            { asset_id: 2639118, include_fields: [], exclude_fields: [] },
            {
              ok: true,
              runId: "call-1",
              generationId: "gen-1",
              responseMode: "artifact",
              resultPathInspected: true,
            },
          ),
          call("hosted_tool_help", {
            tool_name: "hosted_qualys__qualys_gav_asset_get",
            parameters: [{ name: "include_fields", detail: "full" }],
          }),
          call(
            "hosted_qualys__qualys_gav_asset_get",
            { asset_id: 2639118, include_fields: ["assetName"] },
            {
              ok: true,
              runId: "call-2",
              generationId: "gen-1",
              responseMode: "inline",
              resultPathInspected: true,
            },
          ),
        ],
        generationIds: ["gen-1"],
        runIds: ["call-1", "call-2"],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
        mcpDisabled: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
      {
        hostedToolName: "hosted_qualys__qualys_gav_asset_get",
        expectedOutcome: "hosted_call",
        requireUnguided: true,
        requireHostedHelp: false,
        forbiddenHostedToolNames: ["hosted_qualys__qualys_gav_asset_search"],
        requiredHostedArgumentFragments: ["2639118"],
        requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
    );

    expect(analysis).toEqual({ status: "pass", diagnostics: [] });
  });

  it("passes strict vocabulary evidence when help is detailed and the hosted call uses the required filter field", () => {
    const analysis = analyzeConsumerHostedToolEvidence(
      {
        id: "consumer-qualys-vocabulary",
        guidance: "unguided",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["live-qualys-analyst"],
        sessionIds: ["session-1"],
        messageIds: [],
        toolCalls: [
          call("hosted_tool_help", {
            tool_name: "hosted_qualys__qualys_gav_asset_count",
            parameters: [
              {
                name: "filter_body.filters.field",
                query: "last check-in",
                limit: 10,
              },
            ],
          }),
          call(
            "hosted_qualys__qualys_gav_asset_count",
            {
              filter_body: {
                filters: [
                  {
                    field: "qualys.agent.lastCheckedInDate",
                    operator: "LESSER",
                  },
                ],
              },
            },
            { ok: true, runId: "call-1" },
          ),
        ],
        generationIds: ["gen-1"],
        runIds: ["call-1"],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
        mcpDisabled: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
      {
        hostedToolName: "hosted_qualys__qualys_gav_asset_count",
        requireUnguided: true,
        requireDetailedHelpOrVocabularyLookup: true,
        requiredHelpParameterNames: ["filter_body.filters.field"],
        requiredHostedArgumentFragments: ["qualys.agent.lastCheckedInDate"],
        requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
    );

    expect(analysis).toEqual({ status: "pass", diagnostics: [] });
  });

  it("passes strict vocabulary evidence when the agent retries help before the hosted call", () => {
    const analysis = analyzeConsumerHostedToolEvidence(
      {
        id: "consumer-qualys-vocabulary-help-retry",
        guidance: "unguided",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["live-qualys-analyst"],
        sessionIds: ["session-1"],
        messageIds: [],
        toolCalls: [
          call("hosted_tool_help", {
            tool_name: "hosted_qualys__qualys_gav_asset_count",
          }),
          call("hosted_tool_help", {
            tool_name: "hosted_qualys__qualys_gav_asset_count",
            parameters: [
              {
                name: "filter_body.filters.field",
                query: "last check-in",
              },
            ],
          }),
          call(
            "hosted_qualys__qualys_gav_asset_count",
            {
              filter_body: {
                filters: [
                  {
                    field: "qualys.agent.lastCheckedInDate",
                    operator: "LESSER",
                  },
                ],
              },
            },
            { ok: true, runId: "call-1" },
          ),
        ],
        generationIds: ["gen-1"],
        runIds: ["call-1"],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
        mcpDisabled: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
      {
        hostedToolName: "hosted_qualys__qualys_gav_asset_count",
        requireUnguided: true,
        requireDetailedHelpOrVocabularyLookup: true,
        requiredHelpParameterNames: ["filter_body.filters.field"],
        requiredHostedArgumentFragments: ["qualys.agent.lastCheckedInDate"],
        requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
    );

    expect(analysis).toEqual({ status: "pass", diagnostics: [] });
  });

  it("rejects help-only evidence when learned vocabulary is not carried into hosted arguments", () => {
    const analysis = analyzeConsumerHostedToolEvidence(
      {
        id: "consumer-qualys-help-without-learned-argument",
        guidance: "unguided",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["live-qualys-analyst"],
        sessionIds: ["session-1"],
        messageIds: [],
        toolCalls: [
          call("hosted_tool_help", {
            tool_name: "hosted_qualys__qualys_gav_asset_count",
            parameters: [
              {
                name: "filter_body.filters.field",
                query: "last check-in",
              },
            ],
          }),
          call(
            "hosted_qualys__qualys_gav_asset_count",
            {
              filter_body: {
                filters: [
                  {
                    field: "asset.lastUpdated",
                    operator: "LESSER",
                  },
                ],
              },
            },
            { ok: true, runId: "call-1" },
          ),
        ],
        generationIds: ["gen-1"],
        runIds: ["call-1"],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
        mcpDisabled: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
      {
        hostedToolName: "hosted_qualys__qualys_gav_asset_count",
        requireUnguided: true,
        requireDetailedHelpOrVocabularyLookup: true,
        requiredHelpParameterNames: ["filter_body.filters.field"],
        requiredHostedArgumentFragments: ["qualys.agent.lastCheckedInDate"],
        requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
    );

    expect(analysis).toEqual({
      status: "fail",
      diagnostics: [
        "Consumer hosted tool arguments did not include required evidence qualys.agent.lastCheckedInDate",
      ],
    });
  });

  it("passes when strict consumer evidence records result summary and pagination/truncation metadata", () => {
    const analysis = analyzeConsumerHostedToolEvidence(
      {
        id: "consumer-qualys-result-evidence",
        guidance: "unguided",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["live-qualys-analyst"],
        sessionIds: ["session-1"],
        messageIds: [],
        toolCalls: [
          call("hosted_tool_help", {
            tool_name: "hosted_qualys__qualys_gav_asset_search",
            parameters: [
              {
                name: "filter_body.filters.field",
                query: "last check-in",
              },
            ],
          }),
          call(
            "hosted_qualys__qualys_gav_asset_search",
            {
              page_size: 2,
              max_pages: 1,
              filter_body: {
                filters: [{ field: "qualys.agent.lastCheckedInDate" }],
              },
            },
            {
              ok: true,
              runId: "call-1",
              resultPathInspected: true,
              result: {
                next_last_seen_asset_id: 1926621,
                truncated: true,
              },
            },
          ),
        ],
        generationIds: ["gen-1"],
        runIds: ["call-1"],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
        mcpDisabled: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
      {
        hostedToolName: "hosted_qualys__qualys_gav_asset_search",
        requireUnguided: true,
        requireDetailedHelpOrVocabularyLookup: true,
        requiredHelpParameterNames: ["filter_body.filters.field"],
        requiredHostedArgumentFragments: [
          "qualys.agent.lastCheckedInDate",
          "page_size",
          "max_pages",
        ],
        requiredHostedResultFragments: ["truncated"],
        requiredHostedResultSummaryKeys: [
          "resultPathInspected",
          "result.next_last_seen_asset_id",
          "result.truncated",
        ],
        requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
    );

    expect(analysis).toEqual({ status: "pass", diagnostics: [] });
  });

  it("fails when strict consumer result evidence omits result-path or pagination/truncation proof", () => {
    const analysis = analyzeConsumerHostedToolEvidence(
      {
        id: "consumer-qualys-missing-result-evidence",
        guidance: "unguided",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["live-qualys-analyst"],
        sessionIds: ["session-1"],
        messageIds: [],
        toolCalls: [
          call("hosted_tool_help", {
            tool_name: "hosted_qualys__qualys_gav_asset_search",
            parameters: [{ name: "filter_body.filters.field", query: "last" }],
          }),
          call(
            "hosted_qualys__qualys_gav_asset_search",
            {
              page_size: 2,
              max_pages: 1,
              filter_body: {
                filters: [{ field: "qualys.agent.lastCheckedInDate" }],
              },
            },
            { ok: true, runId: "call-1" },
          ),
        ],
        generationIds: ["gen-1"],
        runIds: ["call-1"],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
        mcpDisabled: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
      {
        hostedToolName: "hosted_qualys__qualys_gav_asset_search",
        requireUnguided: true,
        requireDetailedHelpOrVocabularyLookup: true,
        requiredHostedArgumentFragments: ["qualys.agent.lastCheckedInDate"],
        requiredHostedResultFragments: ["truncated"],
        requiredHostedResultSummaryKeys: [
          "resultPathInspected",
          "result.next_last_seen_asset_id",
          "result.truncated",
        ],
        requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
    );

    expect(analysis).toEqual({
      status: "fail",
      diagnostics: [
        "Consumer hosted tool result did not include required evidence truncated",
        "Consumer hosted tool result did not include required summary key resultPathInspected",
        "Consumer hosted tool result did not include required summary key result.next_last_seen_asset_id",
        "Consumer hosted tool result did not include required summary key result.truncated",
      ],
    });
  });

  it("fails when a scenario calls a hosted tool that the manifest forbids", () => {
    const analysis = analyzeConsumerHostedToolEvidence(
      {
        id: "consumer-qualys-known-id-searches-first",
        guidance: "unguided",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["live-qualys-analyst"],
        sessionIds: ["session-1"],
        messageIds: [],
        toolCalls: [
          call("hosted_tool_help", {
            tool_name: "hosted_qualys__qualys_gav_asset_get",
          }),
          call(
            "hosted_qualys__qualys_gav_asset_search",
            {
              filter_body: {
                filters: [{ field: "asset.id", value: "48291" }],
              },
            },
            { ok: true, runId: "call-search" },
          ),
          call(
            "hosted_qualys__qualys_gav_asset_get",
            { asset_id: "48291" },
            { ok: true, runId: "call-get" },
          ),
        ],
        generationIds: ["gen-1"],
        runIds: ["call-search", "call-get"],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
        mcpDisabled: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
      {
        hostedToolName: "hosted_qualys__qualys_gav_asset_get",
        requireUnguided: true,
        forbiddenHostedToolNames: ["hosted_qualys__qualys_gav_asset_search"],
        requiredHostedArgumentFragments: ["48291"],
        requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
    );

    expect(analysis).toEqual({
      status: "fail",
      diagnostics: [
        "Consumer used forbidden hosted tool hosted_qualys__qualys_gav_asset_search",
      ],
    });
  });

  it("fails when hosted tool arguments include a manifest-forbidden fragment", () => {
    const analysis = analyzeConsumerHostedToolEvidence(
      {
        id: "consumer-qualys-qps-limit",
        guidance: "unguided",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["live-qualys-analyst"],
        sessionIds: ["session-1"],
        messageIds: [],
        toolCalls: [
          call("hosted_tool_help", {
            tool_name: "hosted_qualys__qualys_cloud_agent_hostasset_count",
          }),
          call(
            "hosted_qualys__qualys_cloud_agent_hostasset_count",
            { filter_body: { filters: [] }, limit: 10 },
            { ok: true, runId: "call-qps-count" },
          ),
        ],
        generationIds: ["gen-1"],
        runIds: ["call-qps-count"],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
        mcpDisabled: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
      {
        hostedToolName:
          "hosted_qualys__qualys_cloud_agent_hostasset_count",
        requireUnguided: true,
        forbiddenHostedArgumentFragments: ["limit"],
        requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
    );

    expect(analysis).toEqual({
      status: "fail",
      diagnostics: [
        "Consumer hosted tool arguments included forbidden evidence limit",
      ],
    });
  });

  it("fails when refusal outcome claims a forbidden mutation success", () => {
    const analysis = analyzeConsumerHostedToolEvidence(
      {
        id: "consumer-qualys-mutating-false-success",
        guidance: "unguided",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["live-qualys-analyst"],
        sessionIds: ["session-1"],
        messageIds: [],
        outcomeText:
          "I cannot use the hosted read-only surface, but the scan launched successfully.",
        toolCalls: [
          call("hosted_tool_help", {
            tool_name: "hosted_qualys__qualys_vmdr_scan_launch",
          }),
        ],
        generationIds: [],
        runIds: [],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
        mcpDisabled: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
      {
        hostedToolName: "hosted_qualys__qualys_vmdr_scan_launch",
        expectedOutcome: "refusal",
        requireUnguided: true,
        forbiddenOutcomeFragments: ["scan launched"],
        requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
    );

    expect(analysis).toEqual({
      status: "fail",
      diagnostics: [
        "Consumer outcome included forbidden evidence scan launched",
      ],
    });
  });

  it("fails strict vocabulary evidence when help is shallow or the hosted field is wrong", () => {
    const analysis = analyzeConsumerHostedToolEvidence(
      {
        id: "consumer-qualys-shallow-help",
        status: "pass",
        guidance: "prompt_guided",
        diagnostics: [],
        prompts: [],
        agentIds: ["live-qualys-analyst"],
        sessionIds: ["session-1"],
        messageIds: [],
        toolCalls: [
          call("hosted_tool_help", {
            tool_name: "hosted_qualys__qualys_gav_asset_count",
          }),
          call(
            "hosted_qualys__qualys_gav_asset_count",
            { filter_body: { filters: [{ field: "asset.name" }] } },
            { ok: true, runId: "call-1" },
          ),
        ],
        generationIds: ["gen-1"],
        runIds: ["call-1"],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
        mcpDisabled: [],
      },
      {
        hostedToolName: "hosted_qualys__qualys_gav_asset_count",
        requireUnguided: true,
        requireDetailedHelpOrVocabularyLookup: true,
        requiredHostedArgumentFragments: ["qualys.agent.lastCheckedInDate"],
        requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
    );

    expect(analysis).toEqual({
      status: "fail",
      diagnostics: [
        "Consumer scenario was not classified as unguided",
        "Consumer scenario did not record disabled MCP server integration-hub",
        "Consumer hosted_tool_help call did not request full parameter detail or vocabulary lookup",
        "Consumer hosted tool arguments did not include required evidence qualys.agent.lastCheckedInDate",
      ],
    });
  });

  it("fails strict vocabulary evidence when help is full but omits the required parameter path", () => {
    const analysis = analyzeConsumerHostedToolEvidence(
      {
        id: "consumer-qualys-full-tool-help-only",
        guidance: "unguided",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["live-qualys-analyst"],
        sessionIds: ["session-1"],
        messageIds: [],
        toolCalls: [
          call("hosted_tool_help", {
            tool_name: "hosted_qualys__qualys_gav_asset_count",
            tool_detail: "full",
          }),
          call(
            "hosted_qualys__qualys_gav_asset_count",
            {
              filter_body: {
                filters: [
                  {
                    field: "qualys.agent.lastCheckedInDate",
                    operator: "LESSER",
                  },
                ],
              },
            },
            { ok: true, runId: "call-1" },
          ),
        ],
        generationIds: ["gen-1"],
        runIds: ["call-1"],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
        mcpDisabled: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
      {
        hostedToolName: "hosted_qualys__qualys_gav_asset_count",
        requireUnguided: true,
        requireDetailedHelpOrVocabularyLookup: true,
        requiredHelpParameterNames: ["filter_body.filters.field"],
        requiredHostedArgumentFragments: ["qualys.agent.lastCheckedInDate"],
        requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
    );

    expect(analysis).toEqual({
      status: "fail",
      diagnostics: [
        "Consumer hosted_tool_help call did not request required parameter filter_body.filters.field",
      ],
    });
  });

  it("fails strict vocabulary evidence when the required parameter help comes after the hosted call", () => {
    const analysis = analyzeConsumerHostedToolEvidence(
      {
        id: "consumer-qualys-late-vocabulary-help",
        guidance: "unguided",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["live-qualys-analyst"],
        sessionIds: ["session-1"],
        messageIds: [],
        toolCalls: [
          call("hosted_tool_help", {
            tool_name: "hosted_qualys__qualys_gav_asset_count",
          }),
          call(
            "hosted_qualys__qualys_gav_asset_count",
            {
              filter_body: {
                filters: [
                  {
                    field: "qualys.agent.lastCheckedInDate",
                    operator: "LESSER",
                  },
                ],
              },
            },
            { ok: true, runId: "call-1" },
          ),
          call("hosted_tool_help", {
            tool_name: "hosted_qualys__qualys_gav_asset_count",
            parameters: [
              {
                name: "filter_body.filters.field",
                query: "last check-in",
              },
            ],
          }),
        ],
        generationIds: ["gen-1"],
        runIds: ["call-1"],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
        mcpDisabled: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
      {
        hostedToolName: "hosted_qualys__qualys_gav_asset_count",
        requireUnguided: true,
        requireDetailedHelpOrVocabularyLookup: true,
        requiredHelpParameterNames: ["filter_body.filters.field"],
        requiredHostedArgumentFragments: ["qualys.agent.lastCheckedInDate"],
        requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
    );

    expect(analysis).toEqual({
      status: "fail",
      diagnostics: [
        "Consumer hosted_tool_help call did not request full parameter detail or vocabulary lookup",
        "Consumer hosted_tool_help call did not request required parameter filter_body.filters.field",
      ],
    });
  });

  it("passes expected evidence-required, refusal, and recovery outcomes from outcome text", () => {
    const base = {
      id: "consumer-outcome",
      guidance: "unguided" as const,
      status: "pass" as const,
      diagnostics: [],
      prompts: [],
      agentIds: ["live-qualys-analyst"],
      sessionIds: ["session-1"],
      messageIds: [],
      toolCalls: [
        call("hosted_tool_help", {
          tool_name: "hosted_qualys__qualys_gav_asset_count",
        }),
      ],
      generationIds: [],
      runIds: [],
      failureBucketIds: [],
      catalogNoticeIds: [],
      artifactPaths: [],
      mcpDisabled: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
    };

    expect(
      analyzeConsumerHostedToolEvidence(
        {
          ...base,
          outcomeText:
            "EVIDENCE_REQUIRED: provider CVE to QID mapping is not evidenced.",
        },
        {
          hostedToolName: "hosted_qualys__qualys_vmdr_host_detection_list",
          expectedOutcome: "evidence_required",
          requireUnguided: true,
          requiredOutcomeFragments: ["EVIDENCE_REQUIRED"],
          requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
        },
      ),
    ).toEqual({ status: "pass", diagnostics: [] });

    expect(
      analyzeConsumerHostedToolEvidence(
        {
          ...base,
          outcomeText:
            "I cannot launch scans because that operation is outside the read-only hosted surface.",
        },
        {
          hostedToolName: "hosted_qualys__qualys_vmdr_scan_launch",
          expectedOutcome: "refusal",
          requireUnguided: true,
          requiredOutcomeFragments: ["read-only", "outside"],
          requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
        },
      ),
    ).toEqual({ status: "pass", diagnostics: [] });

    expect(
      analyzeConsumerHostedToolEvidence(
        {
          ...base,
          outcomeText:
            "Check authentication and permission configuration, then retry after the rate limit window.",
        },
        {
          hostedToolName: "hosted_qualys__qualys_gav_asset_count",
          expectedOutcome: "recovery",
          requireUnguided: true,
          requiredOutcomeFragments: ["authentication", "permission", "rate"],
          requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
        },
      ),
    ).toEqual({ status: "pass", diagnostics: [] });

    expect(
      analyzeConsumerHostedToolEvidence(
        {
          ...base,
          outcomeText:
            "Enable the hosted capability for this agent, then re-run the request without sharing secrets.",
        },
        {
          hostedToolName: "hosted_qualys__qualys_gav_asset_count",
          expectedOutcome: "recovery",
          requireUnguided: true,
          requiredOutcomeFragments: ["enable", "re-run"],
          requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
        },
      ),
    ).toEqual({ status: "pass", diagnostics: [] });
  });

  it("fails expected non-call outcomes when outcome text is missing the required signal", () => {
    const analysis = analyzeConsumerHostedToolEvidence(
      {
        id: "consumer-outcome-missing",
        guidance: "unguided",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["live-qualys-analyst"],
        sessionIds: ["session-1"],
        messageIds: [],
        outcomeText: "I could not complete the request.",
        toolCalls: [],
        generationIds: [],
        runIds: [],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
        mcpDisabled: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
      {
        hostedToolName: "hosted_qualys__qualys_vmdr_scan_launch",
        expectedOutcome: "refusal",
        requireUnguided: true,
        requiredOutcomeFragments: ["read-only"],
        requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
    );

    expect(analysis).toEqual({
      status: "fail",
      diagnostics: [
        "Consumer outcome did not include required evidence read-only",
        "Consumer outcome did not refuse the request",
      ],
    });
  });

  it("fails when consumer bypasses help, lacks run evidence, or uses old tool namespaces", () => {
    const analysis = analyzeConsumerHostedToolEvidence(
      {
        id: "consumer-qualys-bad",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["live-qualys-analyst"],
        sessionIds: ["session-1"],
        messageIds: [],
        toolCalls: [
          call("managed_qualys__qualys_gav_asset_count"),
          call("memory"),
          call("hosted_qualys__qualys_gav_asset_count"),
        ],
        generationIds: [],
        runIds: [],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
      },
      { hostedToolName: "hosted_qualys__qualys_gav_asset_count" },
    );

    expect(analysis.status).toBe("fail");
    expect(analysis.diagnostics).toEqual([
      "Consumer did not call hosted_tool_help before invocation",
      "Consumer used forbidden non-hosted tool managed_qualys__qualys_gav_asset_count",
      "Consumer hosted tool evidence did not include a run id",
    ]);
  });

  it("fails hosted-only consumer evidence when the agent uses memory for provider/tool semantics", () => {
    const analysis = analyzeConsumerHostedToolEvidence(
      {
        id: "consumer-qualys-memory-bypass",
        guidance: "unguided",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["live-qualys-analyst"],
        sessionIds: ["session-1"],
        messageIds: [],
        toolCalls: [
          call("memory", { command: "view", path: "qualys-notes.md" }),
          call("hosted_tool_help", {
            parameters: [{ name: "params.qids" }],
          }),
          call(
            "hosted_qualys__qualys_vmdr_host_detection_list",
            { status: "Active", params: { qids: "12345" } },
            { ok: true, runId: "call-1" },
          ),
        ],
        generationIds: ["gen-1"],
        runIds: ["call-1"],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
        mcpDisabled: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
      {
        hostedToolName: "hosted_qualys__qualys_vmdr_host_detection_list",
        expectedOutcome: "hosted_call",
        requireUnguided: true,
        requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
    );

    expect(analysis.diagnostics).toContain(
      "Consumer used forbidden non-hosted tool memory",
    );
  });

  it("analyzes the successful hosted retry when the first business call fails", () => {
    const analysis = analyzeConsumerHostedToolEvidence(
      {
        id: "consumer-qualys-recovered",
        guidance: "unguided",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["live-qualys-analyst"],
        sessionIds: ["session-1"],
        messageIds: [],
        toolCalls: [
          call("hosted_tool_help", {
            tool_detail: "full",
            parameters: [{ name: "page_size" }, { name: "max_pages" }],
          }),
          call(
            "hosted_qualys__qualys_gav_asset_search",
            { page_size: 1, max_pages: 2 },
            { ok: false },
          ),
          call("hosted_tool_help", {
            parameters: [{ name: "include_fields" }],
          }),
          call(
            "hosted_qualys__qualys_gav_asset_search",
            {
              page_size: 2,
              max_pages: 2,
              filter_body: {
                filters: [
                  {
                    field: "qualys.agent.lastCheckedInDate",
                    operator: "LESS_THAN",
                    value: "2026-07-01T00:00:00Z",
                  },
                ],
              },
            },
            {
              ok: true,
              runId: "call-1",
              resultPathInspected: true,
              result: {
                next_last_seen_asset_id: 1926621,
                truncated: true,
              },
            },
          ),
        ],
        generationIds: ["gen-1"],
        runIds: ["call-1"],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
        mcpDisabled: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
      {
        hostedToolName: "hosted_qualys__qualys_gav_asset_search",
        expectedOutcome: "hosted_call",
        requireUnguided: true,
        requireDetailedHelpOrVocabularyLookup: true,
        requiredHostedArgumentFragments: [
          "qualys.agent.lastCheckedInDate",
          "2026-07-01T00:00:00Z",
          "page_size",
          "max_pages",
        ],
        requiredHostedResultSummaryKeys: [
          "resultPathInspected",
          "result.next_last_seen_asset_id",
          "result.truncated",
        ],
        requiredDisabledMcpServers: [LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME],
      },
    );

    expect(analysis).toEqual({ status: "pass", diagnostics: [] });
  });
});

describe("Hosted tool catalog refresh analyzer", () => {
  it("passes when an already granted open session sees a newly promoted hosted tool", () => {
    const analysis = analyzeCatalogRefreshEvidence(
      {
        id: "catalog-refresh",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["granted-agent", "ungranted-agent"],
        sessionIds: ["session-granted", "session-ungranted"],
        messageIds: [],
        toolCalls: [
          call(
            "hosted_catalog-live__catalog_echo",
            { text: "hello" },
            {
              ok: true,
              runId: "call-1",
            },
          ),
        ].map((item) => ({
          ...item,
          agentId: "granted-agent",
          sessionId: "session-granted",
        })),
        generationIds: ["gen-1"],
        runIds: ["call-1"],
        failureBucketIds: [],
        catalogNoticeIds: ["notice-1"],
        artifactPaths: [],
      },
      {
        hostedToolName: "hosted_catalog-live__catalog_echo",
        grantedAgentId: "granted-agent",
        ungrantedAgentId: "ungranted-agent",
        notices: [
          {
            id: "notice-1",
            agentId: "granted-agent",
            addedToolNames: ["hosted_catalog-live__catalog_echo"],
            removedToolNames: [],
            addedHostedTools: [
              {
                toolName: "hosted_catalog-live__catalog_echo",
                grantStatus: "granted",
              },
            ],
          },
        ],
        modelContextNoticeDetected: false,
        remoteMcpBoundaryOk: true,
      },
    );

    expect(analysis).toEqual({ status: "pass", diagnostics: [] });
  });

  it("fails when catalog refresh grants visibility without settings boundary proof", () => {
    const analysis = analyzeCatalogRefreshEvidence(
      {
        id: "catalog-refresh-bad",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["granted-agent", "ungranted-agent"],
        sessionIds: ["session-granted", "session-ungranted"],
        messageIds: [],
        toolCalls: [
          {
            ...call("hosted_catalog-live__catalog_echo"),
            agentId: "ungranted-agent",
            sessionId: "session-ungranted",
          },
        ],
        generationIds: [],
        runIds: [],
        failureBucketIds: [],
        catalogNoticeIds: [],
        artifactPaths: [],
      },
      {
        hostedToolName: "hosted_catalog-live__catalog_echo",
        grantedAgentId: "granted-agent",
        ungrantedAgentId: "ungranted-agent",
        notices: [
          {
            agentId: "ungranted-agent",
            addedToolNames: ["hosted_catalog-live__catalog_echo"],
            removedToolNames: [],
            addedHostedTools: [],
          },
        ],
        modelContextNoticeDetected: true,
        remoteMcpBoundaryOk: false,
      },
    );

    expect(analysis.status).toBe("fail");
    expect(analysis.diagnostics).toEqual([
      "Granted open session did not call newly visible hosted tool hosted_catalog-live__catalog_echo",
      "Granted open session did not receive catalog notice for hosted_catalog-live__catalog_echo",
      "Ungranted open session called hosted tool hosted_catalog-live__catalog_echo",
      "Ungranted open session received catalog notice for hosted_catalog-live__catalog_echo",
      "Catalog notice leaked into canonical chat message context",
      "Remote MCP selection incorrectly enabled hosted tool access",
      "Catalog refresh scenario evidence did not include notice ids",
    ]);
  });
});

describe("Live parity matrix analyzer", () => {
  it("passes when every source-backed family is reported with pass or explicit skip", () => {
    const analysis = analyzeLiveParityMatrixEvidence(
      {
        id: "live-parity-matrix",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: [],
        sessionIds: [],
        messageIds: [],
        toolCalls: [],
        generationIds: [],
        runIds: [],
        failureBucketIds: [],
        catalogNoticeIds: [],
        parityResults: [
          parityResult("qualys", "pass", {
            caseCount: 5,
            matchedCaseCount: 5,
            artifactPath: "/tmp/qualys.json",
          }),
          parityResult("splunk", "skipped", {
            diagnostics: ["SPLUNK_TOKEN is not configured"],
          }),
          parityResult("msgraph", "pass", {
            caseCount: 1,
            matchedCaseCount: 1,
            artifactPath: "/tmp/msgraph.json",
          }),
          parityResult("mde", "skipped", {
            diagnostics: ["MDE_CLIENT_SECRET is not configured"],
          }),
          parityResult("defender-alert", "skipped", {
            diagnostics: ["DEFENDER_CLIENT_SECRET is not configured"],
          }),
        ],
        artifactPaths: ["/tmp/qualys.json", "/tmp/msgraph.json"],
      },
      {
        expectedFamilyIds: [
          "qualys",
          "splunk",
          "msgraph",
          "mde",
          "defender-alert",
        ],
        requiredPassFamilyIds: ["qualys"],
      },
    );

    expect(analysis).toEqual({ status: "pass", diagnostics: [] });
  });

  it("fails on missing families, failed parity, weak skips, and unlinked artifacts", () => {
    const analysis = analyzeLiveParityMatrixEvidence(
      {
        id: "live-parity-matrix-bad",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: [],
        sessionIds: [],
        messageIds: [],
        toolCalls: [],
        generationIds: [],
        runIds: [],
        failureBucketIds: [],
        catalogNoticeIds: [],
        parityResults: [
          parityResult("qualys", "skipped"),
          parityResult("splunk", "fail", {
            diagnostics: ["comparison mismatch"],
            caseCount: 1,
            matchedCaseCount: 0,
            artifactPath: "/tmp/splunk.json",
          }),
          parityResult("unexpected", "pass", {
            caseCount: 1,
            matchedCaseCount: 1,
          }),
        ],
        artifactPaths: [],
      },
      {
        expectedFamilyIds: ["qualys", "splunk", "msgraph"],
        requiredPassFamilyIds: ["qualys"],
      },
    );

    expect(analysis.status).toBe("fail");
    expect(analysis.diagnostics).toEqual([
      "Live parity skipped family qualys without an explicit diagnostic",
      "Live parity failed for family splunk",
      "Live parity artifact for family splunk was not linked from scenario evidence",
      "Live parity matrix did not report family msgraph",
      "Live parity family qualys was required to pass",
      "Live parity reported unexpected family unexpected",
    ]);
  });
});

describe("Tool Developer repair behavior analyzer", () => {
  it("passes when Tool Developer repairs a code-owned failure with regression proof", () => {
    const analysis = analyzeToolDeveloperRepairBehaviorEvidence(
      {
        id: "tool-developer-repair",
        status: "pass",
        diagnostics: [],
        prompts: [],
        agentIds: ["tool-developer"],
        sessionIds: ["session-repair"],
        messageIds: [],
        toolCalls: [
          call("skill_view", { name: "hosted-integrations-development" }),
          call("hosted_tool_failure_bucket_get", {
            bucket_id: "bucket-1",
            family_id: "repair-live",
            tool_name: "repair_live_echo",
          }),
          call("hosted_tool_run_get", { run_id: "call-failed" }),
          call("hosted_tool_source_view", {
            family_id: "repair-live",
            tool_name: "repair_live_echo",
          }),
          call("hosted_tool_lock_acquire", { family_id: "repair-live" }),
          call("hosted_tool_draft_create", { family_id: "repair-live" }),
          call("hosted_tool_draft_patch", { path: "repair_live.py" }),
          call("hosted_tool_example_upsert", {
            tool_name: "repair_live_echo",
            category: "regression",
          }),
          call("hosted_tool_validate"),
          call(
            "hosted_tool_promote",
            { draft_id: "draft-1" },
            {
              ok: true,
              generation: "[object]",
            },
          ),
          call(
            "hosted_tool_debug_run",
            { generation_id: "gen-fixed" },
            {
              ok: true,
              runId: "call-debug",
            },
          ),
          call(
            "hosted_tool_failure_bucket_close",
            {
              bucket_id: "bucket-1",
              draft_id: "draft-1",
              generation_id: "gen-fixed",
              regression_example_id: "regression-1",
            },
            { ok: true },
          ),
        ],
        generationIds: ["gen-fixed"],
        runIds: ["call-failed", "call-debug"],
        failureBucketIds: ["bucket-1"],
        catalogNoticeIds: [],
        artifactPaths: [],
      },
      {
        familyId: "repair-live",
        toolName: "repair_live_echo",
        bucketId: "bucket-1",
      },
    );

    expect(analysis).toEqual({ status: "pass", diagnostics: [] });
  });

  it("fails when Tool Developer patches before investigation and skips repair proof", () => {
    const analysis = analyzeToolDeveloperRepairBehaviorEvidence({
      id: "tool-developer-repair-bad",
      status: "pass",
      diagnostics: [],
      prompts: [],
      agentIds: ["tool-developer"],
      sessionIds: [],
      messageIds: [],
      toolCalls: [
        call("skill_view", { name: "hosted-integrations-development" }),
        call("hosted_tool_lock_acquire"),
        call("hosted_tool_draft_patch", {
          content: "handlerDispatch = call_tool",
        }),
        call("hosted_tool_promote"),
        call(
          "hosted_tool_failure_bucket_close",
          { bucket_id: "bucket-1" },
          {
            ok: false,
          },
        ),
      ],
      generationIds: [],
      runIds: [],
      failureBucketIds: [],
      catalogNoticeIds: [],
      artifactPaths: [],
    });

    expect(analysis.status).toBe("fail");
    expect(analysis.diagnostics).toEqual([
      "Tool Developer attempted a forbidden design mutation in tool call #3",
      "Tool Developer did not inspect the failing hosted run",
      "Tool Developer did not inspect the failure bucket",
      "Tool Developer did not inspect focused source view",
      "Tool Developer patched before inspecting the failing run",
      "Tool Developer patched before inspecting the failure bucket",
      "Tool Developer patched before inspecting focused source",
      "Tool Developer did not add a regression example",
      "Tool Developer promoted repair without validating after the final source/example change",
      "Tool Developer promoted repair without adding the regression example first",
      "Tool Developer did not debug-run the repaired generation",
      "Tool Developer closed bucket without generation evidence",
      "Tool Developer closed bucket without regression example evidence",
      "Tool Developer failure bucket close was rejected",
      "Repair scenario evidence did not include a failure bucket id",
      "Repair scenario evidence did not include hosted run evidence",
      "Repair scenario evidence did not include repaired generation id",
    ]);
  });
});

function isolatedDataDir(): string {
  const dir = mkdtempSync(
    path.join(tmpdir(), ".openamce-hosted-integrations-test-env-"),
  );
  dataDirs.push(dir);
  return dir;
}

function scenario(
  id: string,
  overrides: {
    status?: "pass" | "fail" | "skipped";
    diagnostics?: string[];
    prompts?: string[];
    agentIds?: string[];
    sessionIds?: string[];
    messageIds?: string[];
    outcomeText?: string;
    guidance?: "prompt_guided" | "unguided" | "operator_instrumented";
    expectedOutcome?: "hosted_call" | "evidence_required" | "refusal" | "recovery";
    availableToolNames?: string[];
    toolCalls?: ReturnType<typeof call>[];
    generationIds?: string[];
    runIds?: string[];
    failureBucketIds?: string[];
    catalogNoticeIds?: string[];
    parityResults?: ReturnType<typeof parityResult>[];
    artifactPaths?: string[];
  } = {},
) {
  return {
    id,
    status: overrides.status ?? "pass",
    diagnostics: overrides.diagnostics ?? [],
    prompts: overrides.prompts ?? [],
    agentIds: overrides.agentIds ?? [],
    sessionIds: overrides.sessionIds ?? [],
    messageIds: overrides.messageIds ?? [],
    ...(overrides.outcomeText ? { outcomeText: overrides.outcomeText } : {}),
    ...(overrides.guidance ? { guidance: overrides.guidance } : {}),
    ...(overrides.expectedOutcome
      ? { expectedOutcome: overrides.expectedOutcome }
      : {}),
    availableToolNames: overrides.availableToolNames ?? [],
    toolCalls: overrides.toolCalls ?? [],
    generationIds: overrides.generationIds ?? [],
    runIds: overrides.runIds ?? [],
    failureBucketIds: overrides.failureBucketIds ?? [],
    catalogNoticeIds: overrides.catalogNoticeIds ?? [],
    parityResults: overrides.parityResults ?? [],
    artifactPaths: overrides.artifactPaths ?? [],
  };
}

function call(
  toolName: string,
  argsSummary?: Record<string, unknown>,
  resultSummary?: Record<string, unknown>,
): {
  toolName: string;
  status: "output";
  argsSummary?: Record<string, unknown>;
  resultSummary?: Record<string, unknown>;
} {
  return {
    toolName,
    status: "output",
    ...(argsSummary ? { argsSummary } : {}),
    ...(resultSummary ? { resultSummary } : {}),
  };
}

function parityResult(
  familyId: string,
  status: "pass" | "fail" | "skipped",
  overrides: {
    diagnostics?: string[];
    artifactPath?: string;
    caseCount?: number;
    matchedCaseCount?: number;
    errorCaseCount?: number;
  } = {},
) {
  return {
    familyId,
    status,
    runId: `live_parity_${familyId}`,
    diagnostics: overrides.diagnostics ?? [],
    caseCount: overrides.caseCount ?? 0,
    matchedCaseCount: overrides.matchedCaseCount ?? 0,
    errorCaseCount: overrides.errorCaseCount ?? 0,
    ...(overrides.artifactPath ? { artifactPath: overrides.artifactPath } : {}),
  };
}
