import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LIVE_HOSTED_TOOL_ACCEPTANCE_SCHEMA_VERSION,
  analyzeCatalogRefreshEvidence,
  analyzeConsumerHostedToolEvidence,
  analyzeLiveParityMatrixEvidence,
  analyzeToolDeveloperBehaviorEvidence,
  analyzeToolDeveloperRepairBehaviorEvidence,
  assertLiveHostedToolsDataDirIsIsolated,
  buildLiveHostedToolAcceptanceArtifact,
  liveHostedToolAcceptanceCriticalFailures,
  renderLiveHostedToolAcceptanceSummary,
  extractLiveHostedToolCallsFromMessageHistory,
  scanLiveHostedToolAcceptanceSecrets,
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
          status: "pass",
          diagnostics: [],
          prompts: ["create a safe hosted tool"],
          agentIds: ["tool-developer"],
          sessionIds: ["session-1"],
          messageIds: ["message-1"],
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
          sessionIds: ["session-qualys"],
          runIds: ["call-qualys"],
          generationIds: ["gen-qualys"],
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
    expect(summary).toContain("- Tool Developer behavior: pass (guidance prompt_guided");
    expect(summary).toContain(
      "- Business hosted invocation: pass (guidance prompt_guided; sessions session-qualys; runs call-qualys; generations gen-qualys)",
    );
    expect(summary).toContain("- Denied access boundary: pass (guidance prompt_guided");
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
          diagnostics: ["Consumer did not call hosted_tool_help before invocation"],
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
          call("hosted_catalog-live__catalog_echo", { text: "hello" }, {
            ok: true,
            runId: "call-1",
          }),
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
          call("hosted_tool_promote", { draft_id: "draft-1" }, {
            ok: true,
            generation: "[object]",
          }),
          call("hosted_tool_debug_run", { generation_id: "gen-fixed" }, {
            ok: true,
            runId: "call-debug",
          }),
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
        call("hosted_tool_failure_bucket_close", { bucket_id: "bucket-1" }, {
          ok: false,
        }),
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
