import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIVE_HOSTED_TOOL_ACCEPTANCE_SCHEMA_VERSION } from "../test-support/hosted-tools/live-acceptance.js";
import {
  UNGUIDED_HOSTED_TOOL_MANAGEMENT_SCHEMA_VERSION,
  analyzeUnguidedManagementScenario,
  buildUnguidedManagementArtifact,
  lintUnguidedManagementPrompt,
  renderUnguidedManagementSummary,
  writeUnguidedManagementArtifact,
  type UnguidedManagementScenarioEvidence,
} from "../test-support/hosted-tools/unguided-management.js";

let dataDirs: string[] = [];

afterEach(() => {
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
});

describe("unguided hosted-tool management prompt lint", () => {
  it("accepts natural hosted-tool management intent without tool hints", () => {
    const prompt = [
      "Create a config-free read-only hosted tool family for evaluating text echo behavior.",
      "Use the family id unguided_echo and native tool name echo_text.",
      "Make it safe and ready for a test agent to use.",
    ].join("\n");

    expect(lintUnguidedManagementPrompt(prompt)).toEqual({
      status: "pass",
      findings: [],
    });
  });

  it("rejects explicit management tool names and ordered recipes", () => {
    const prompt = [
      "1. Call hosted_tool_lock_acquire.",
      "2. Then call hosted_tool_draft_patch with this JSON:",
      '{"family_id":"x","tool_name":"echo_text"}',
    ].join("\n");

    const lint = lintUnguidedManagementPrompt(prompt);

    expect(lint.status).toBe("fail");
    expect(lint.findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining([
        "explicit-management-tool-name",
        "hosted-tool-prefix",
        "management-json-shape",
        "ordered-tool-recipe",
      ]),
    );
  });

  it("rejects prompts that tell Tool Developer to invent provider behavior", () => {
    const prompt = [
      "Create a hosted Qualys filter tool.",
      "If provider docs are missing, just guess the API field names and response schema so the integration can proceed.",
    ].join("\n");

    const lint = lintUnguidedManagementPrompt(prompt);

    expect(lint.status).toBe("fail");
    expect(lint.findings).toContainEqual(
      expect.objectContaining({ rule: "invent-provider-behavior" }),
    );
  });

  it("rejects prompts that tell Tool Developer to invent destructive behavior", () => {
    const prompt = [
      "Create a hosted Qualys scan tool.",
      "If docs are missing, fabricate the destructive side effects and confirmation behavior so the tool can still be promoted.",
    ].join("\n");

    const lint = lintUnguidedManagementPrompt(prompt);

    expect(lint.status).toBe("fail");
    expect(lint.findings).toContainEqual(
      expect.objectContaining({ rule: "invent-provider-behavior" }),
    );
  });
});

describe("unguided hosted-tool management analyzer", () => {
  it("scores a valid create/edit/publish lifecycle transcript", () => {
    const base = scenario({
      scenarioKind: "create",
      toolCalls: [
        call("skill_view", { name: "hosted-integrations-development" }),
        call("hosted_tool_family_list"),
        call("hosted_tool_family_create", {
          family_id: "unguided_echo",
          tool_name: "echo_text",
        }),
        call("hosted_tool_lock_acquire", { family_id: "unguided_echo" }),
        call("hosted_tool_draft_create", {
          family_id: "unguided_echo",
          lock_id: "lock-1",
        }),
        call("hosted_tool_draft_patch", {
          draft_id: "draft-1",
          lock_id: "lock-1",
          path: "family.yaml",
        }),
        call("hosted_tool_draft_patch", {
          draft_id: "draft-1",
          lock_id: "lock-1",
          path: "unguided_echo.py",
        }),
        call("hosted_tool_example_upsert", {
          draft_id: "draft-1",
          lock_id: "lock-1",
        }),
        call("hosted_tool_validate", { draft_id: "draft-1" }),
        call("hosted_tool_example_run", {
          draft_id: "draft-1",
          example_id: "smoke_echo",
        }),
        call("hosted_tool_readiness_get", {
          target_type: "publish",
          draft_id: "draft-1",
        }),
        call("hosted_tool_promote", {
          draft_id: "draft-1",
          lock_id: "lock-1",
        }),
        call("hosted_tool_lock_release", { lock_id: "lock-1" }),
      ],
    });

    const analysis = analyzeUnguidedManagementScenario(base, {
      scenarioKind: "create",
      requirePromotion: true,
    });

    expect(analysis.status).toBe("pass");
    expect(analysis.failureTaxonomy).toEqual([]);
    expect(analysis.scorecard.find((entry) => entry.key === "surface_selection"))
      .toMatchObject({ status: "pass", score: 1 });
  });

  it("accepts family_create as the lock and draft preparation for new families", () => {
    const base = scenario({
      scenarioKind: "remote_mcp_boundary",
      toolCalls: [
        call("skill_view", { name: "hosted-integrations-development" }),
        call("hosted_tool_family_create", {
          family_id: "unguided_echo",
          tool_name: "echo_text",
        }),
        call("hosted_tool_draft_get", { draft_id: "draft-1" }),
        call("hosted_tool_draft_patch", {
          draft_id: "draft-1",
          lock_id: "lock-1",
          path: "family.yaml",
        }),
        call("hosted_tool_example_upsert", {
          draft_id: "draft-1",
          lock_id: "lock-1",
        }),
        call("hosted_tool_validate", { draft_id: "draft-1" }),
        call("hosted_tool_example_run", {
          draft_id: "draft-1",
          example_id: "smoke_echo",
        }),
        call("hosted_tool_readiness_get", {
          target_type: "publish",
          draft_id: "draft-1",
        }),
        call("hosted_tool_promote", {
          draft_id: "draft-1",
          lock_id: "lock-1",
        }),
      ],
    });

    const analysis = analyzeUnguidedManagementScenario(base, {
      scenarioKind: "remote_mcp_boundary",
      requirePromotion: true,
    });

    expect(analysis.status).toBe("pass");
    expect(analysis.failureTaxonomy).not.toContain("lock_missing");
    expect(analysis.scorecard.find((entry) => entry.key === "lock_and_draft"))
      .toMatchObject({ status: "pass", diagnostics: [] });
  });

  it("passes lock-boundary evidence when the agent stops after a lock conflict", () => {
    const base = scenario({
      scenarioKind: "lock_boundary",
      toolCalls: [
        call("skill_view", { name: "hosted-integrations-development" }),
        {
          ...call("hosted_tool_lock_acquire", {
            family_id: "locked_family",
            ttl_ms: 600000,
          }),
          resultSummary: { ok: false, error: { code: "locked" } },
        },
      ],
    });

    const analysis = analyzeUnguidedManagementScenario(base, {
      scenarioKind: "lock_boundary",
      requirePromotion: false,
    });

    expect(analysis.status).toBe("pass");
    expect(analysis.failureTaxonomy).toEqual([]);
    expect(analysis.scorecard.find((entry) => entry.key === "source_focus"))
      .toMatchObject({ status: "not_applicable", diagnostics: [] });
  });

  it("hard-fails wrong lifecycle surfaces and forbidden design mutations", () => {
    const base = scenario({
      scenarioKind: "repair",
      toolCalls: [
        call("mcp_integration-hub__qualys_asset_count"),
        call("apply_patch", {
          path: "packages/server/src/runtime.ts",
          content: "handlerDispatch: legacy_call_tool",
        }),
      ],
    });

    const analysis = analyzeUnguidedManagementScenario(base, {
      scenarioKind: "repair",
      requirePromotion: true,
      requireDebugProof: true,
    });

    expect(analysis.status).toBe("fail");
    expect(analysis.failureTaxonomy).toEqual(
      expect.arrayContaining([
        "wrong_surface",
        "remote_mcp_substitution",
        "generic_platform_patch",
      ]),
    );
    expect(analysis.hardFailures.join("\n")).toContain(
      "Wrong lifecycle surface used",
    );
    expect(analysis.hardFailures.join("\n")).toContain(
      "forbidden platform/design mutation",
    );
  });

  it("records partial lifecycle quality gaps without hiding evidence", () => {
    const base = scenario({
      scenarioKind: "edit",
      toolCalls: [
        call("hosted_tool_family_list"),
        call("hosted_tool_lock_acquire", { family_id: "unguided_echo" }),
        call("hosted_tool_draft_create", {
          family_id: "unguided_echo",
          lock_id: "lock-1",
        }),
        call("hosted_tool_draft_patch", {
          draft_id: "draft-1",
          lock_id: "lock-1",
          path: "family.yaml",
        }),
        call("hosted_tool_promote", {
          draft_id: "draft-1",
          lock_id: "lock-1",
        }),
      ],
    });

    const analysis = analyzeUnguidedManagementScenario(base, {
      scenarioKind: "edit",
      requirePromotion: true,
    });

    expect(analysis.status).toBe("fail");
    expect(analysis.failureTaxonomy).toEqual(
      expect.arrayContaining([
        "source_focus_missing",
        "validation_skipped",
        "promote_without_readiness",
      ]),
    );
    expect(analysis.qualityFindings.join("\n")).toContain(
      "Agent did not inspect focused source/draft before patching",
    );
  });
});

describe("unguided hosted-tool management artifact", () => {
  it("requires unguided management classification and writes separate evidence", async () => {
    const dataDir = isolatedDataDir();
    const raw = scenario({
      scenarioKind: "create",
      toolCalls: [
        call("hosted_tool_family_list"),
        call("hosted_tool_family_create", {
          family_id: "unguided_echo",
          tool_name: "echo_text",
        }),
      ],
    });
    const analysis = analyzeUnguidedManagementScenario(raw, {
      scenarioKind: "create",
      requirePromotion: false,
    });
    const completeScenario: UnguidedManagementScenarioEvidence = {
      ...raw,
      ...analysis,
    };
    const artifact = buildUnguidedManagementArtifact({
      runId: "unguided_management_test",
      startedAt: new Date("2026-08-16T12:00:00.000Z"),
      completedAt: new Date("2026-08-16T12:00:01.000Z"),
      dataDir,
      baseUrl: "http://127.0.0.1:3466",
      model: { provider: "openai", model: "gpt-5.5", auth: "oauth" },
      scenarios: [completeScenario],
    });

    const written = await writeUnguidedManagementArtifact(dataDir, artifact);
    const summary = renderUnguidedManagementSummary(
      artifact,
      written.artifactPath,
    );

    expect(artifact.schemaVersion).toBe(
      UNGUIDED_HOSTED_TOOL_MANAGEMENT_SCHEMA_VERSION,
    );
    expect(artifact.relatedLiveAcceptanceSchemaVersion).toBe(
      LIVE_HOSTED_TOOL_ACCEPTANCE_SCHEMA_VERSION,
    );
    expect(written.artifactPath).toBe(
      path.join(
        dataDir,
        "hosted-integrations",
        "live-unguided-management",
        "unguided_management_test.json",
      ),
    );
    expect(JSON.parse(readFileSync(written.latestPath, "utf8"))).toMatchObject({
      runId: "unguided_management_test",
      artifactPath: written.artifactPath,
      summaryPath: written.summaryPath,
    });
    expect(summary).toContain("Surface: hosted_tool_management");
    expect(summary).toContain("Guidance: unguided");
    expect(summary).toContain("hintPolicy none");
  });

  it("rejects prompt-guided scenario evidence in the unguided gate", () => {
    expect(() =>
      buildUnguidedManagementArtifact({
        runId: "bad_guidance",
        dataDir: isolatedDataDir(),
        baseUrl: "http://127.0.0.1:3466",
        model: { provider: "openai", model: "gpt-5.5" },
        scenarios: [
          {
            ...scenario({ scenarioKind: "create", toolCalls: [] }),
            guidance: "prompt_guided",
          } as unknown as UnguidedManagementScenarioEvidence,
        ],
      }),
    ).toThrow();
  });
});

function scenario(input: {
  scenarioKind: UnguidedManagementScenarioEvidence["scenarioKind"];
  toolCalls: UnguidedManagementScenarioEvidence["toolCalls"];
}): Omit<
  UnguidedManagementScenarioEvidence,
  "scorecard" | "failureTaxonomy" | "hardFailures" | "qualityFindings"
> {
  const prompt =
    "Create a config-free read-only hosted tool family for test use.";
  return {
    id: `unguided-management-${input.scenarioKind}`,
    title: `Unguided Management ${input.scenarioKind}`,
    scenarioKind: input.scenarioKind,
    guidance: "unguided",
    surface: "hosted_tool_management",
    hintPolicy: "none",
    attemptNo: 1,
    status: "pass",
    diagnostics: [],
    prompts: [prompt],
    promptLint: lintUnguidedManagementPrompt(prompt),
    agentIds: ["tool-developer"],
    sessionIds: ["session-1"],
    messageIds: ["message-1"],
    toolCalls: input.toolCalls,
    generationIds: [],
    runIds: [],
    failureBucketIds: [],
    lockIds: [],
    draftIds: [],
  };
}

function call(
  toolName: string,
  argsSummary: Record<string, unknown> = {},
): UnguidedManagementScenarioEvidence["toolCalls"][number] {
  return {
    agentId: "tool-developer",
    sessionId: "session-1",
    messageId: "message-1",
    toolName,
    status: "output",
    argsSummary,
    resultSummary: { ok: true },
  };
}

function isolatedDataDir(): string {
  const dir = mkdtempSync(
    path.join(tmpdir(), ".openamce-hosted-integrations-test-env-"),
  );
  dataDirs.push(dir);
  return dir;
}
