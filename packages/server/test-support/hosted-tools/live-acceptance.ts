import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { z } from "zod";

export const LIVE_HOSTED_TOOL_ACCEPTANCE_SCHEMA_VERSION =
  "2026-08-15.live-hosted-tool-acceptance.v1";

export const DEFAULT_LIVE_HOSTED_TOOLS_DATA_DIR = path.join(
  homedir(),
  ".openamce-hosted-integrations-test-env",
);

const FORBIDDEN_DEFAULT_DATA_DIRS = [
  path.join(homedir(), ".openacme"),
  path.join(homedir(), ".openacme-production"),
];

export const LiveHostedToolAcceptanceStatusSchema = z.enum([
  "pass",
  "fail",
  "skipped",
]);
export type LiveHostedToolAcceptanceStatus = z.infer<
  typeof LiveHostedToolAcceptanceStatusSchema
>;

export const LiveHostedToolCallEvidenceSchema = z
  .object({
    agentId: z.string().optional(),
    sessionId: z.string().optional(),
    messageId: z.string().optional(),
    toolName: z.string().min(1),
    status: z.enum(["called", "output", "error"]).default("called"),
    argsSummary: z.record(z.string(), z.unknown()).optional(),
    resultSummary: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type LiveHostedToolCallEvidence = z.infer<
  typeof LiveHostedToolCallEvidenceSchema
>;

export const LiveHostedToolParityResultSchema = z
  .object({
    familyId: z.string().min(1),
    status: LiveHostedToolAcceptanceStatusSchema,
    runId: z.string().min(1),
    diagnostics: z.array(z.string()).default([]),
    artifactPath: z.string().optional(),
    caseCount: z.number().int().min(0).default(0),
    matchedCaseCount: z.number().int().min(0).default(0),
    errorCaseCount: z.number().int().min(0).default(0),
  })
  .strict();
export type LiveHostedToolParityResult = z.infer<
  typeof LiveHostedToolParityResultSchema
>;

export const LiveHostedToolScenarioEvidenceSchema = z
  .object({
    id: z.string().min(1),
    status: LiveHostedToolAcceptanceStatusSchema,
    diagnostics: z.array(z.string()).default([]),
    prompts: z.array(z.string()).default([]),
    agentIds: z.array(z.string()).default([]),
    sessionIds: z.array(z.string()).default([]),
    messageIds: z.array(z.string()).default([]),
    toolCalls: z.array(LiveHostedToolCallEvidenceSchema).default([]),
    generationIds: z.array(z.string()).default([]),
    runIds: z.array(z.string()).default([]),
    failureBucketIds: z.array(z.string()).default([]),
    catalogNoticeIds: z.array(z.string()).default([]),
    parityResults: z.array(LiveHostedToolParityResultSchema).default([]),
    artifactPaths: z.array(z.string()).default([]),
  })
  .strict();
export type LiveHostedToolScenarioEvidence = Omit<
  z.infer<typeof LiveHostedToolScenarioEvidenceSchema>,
  "parityResults"
> & {
  parityResults?: LiveHostedToolParityResult[];
};

export const LiveHostedToolSecretScanFindingSchema = z
  .object({
    path: z.string().min(1),
    rule: z.string().min(1),
    excerpt: z.string().min(1),
  })
  .strict();
export type LiveHostedToolSecretScanFinding = z.infer<
  typeof LiveHostedToolSecretScanFindingSchema
>;

export const LiveHostedToolSecretScanSchema = z
  .object({
    status: z.enum(["pass", "fail"]),
    findings: z.array(LiveHostedToolSecretScanFindingSchema).default([]),
  })
  .strict();
export type LiveHostedToolSecretScan = z.infer<
  typeof LiveHostedToolSecretScanSchema
>;

export const LiveHostedToolAcceptanceArtifactSchema = z
  .object({
    schemaVersion: z.literal(LIVE_HOSTED_TOOL_ACCEPTANCE_SCHEMA_VERSION),
    runId: z.string().min(1),
    status: LiveHostedToolAcceptanceStatusSchema,
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    dataDir: z.string().min(1),
    baseUrl: z.string().url(),
    model: z
      .object({
        provider: z.string().optional(),
        model: z.string().optional(),
        auth: z.string().optional(),
        baseUrlPresent: z.boolean().default(false),
      })
      .strict(),
    diagnostics: z.array(z.string()).default([]),
    scenarios: z.array(LiveHostedToolScenarioEvidenceSchema).default([]),
    secretScan: LiveHostedToolSecretScanSchema,
  })
  .strict();
export type LiveHostedToolAcceptanceArtifact = z.infer<
  typeof LiveHostedToolAcceptanceArtifactSchema
>;

export interface BuildLiveHostedToolAcceptanceArtifactInput {
  runId?: string;
  startedAt?: Date;
  completedAt?: Date;
  dataDir: string;
  baseUrl: string;
  model: {
    provider?: string;
    model?: string;
    auth?: string;
    baseUrl?: string;
  };
  diagnostics?: string[];
  scenarios?: LiveHostedToolScenarioEvidence[];
}

export interface LiveHostedToolAcceptanceReportPaths {
  summaryPath: string;
  latestPath: string;
}

export interface ToolDeveloperBehaviorAnalysis {
  status: "pass" | "fail";
  diagnostics: string[];
}

export interface ConsumerHostedToolBehaviorAnalysisInput {
  hostedToolName: string;
}

export interface CatalogRefreshNoticeEvidence {
  id?: string;
  agentId?: string;
  addedToolNames: string[];
  removedToolNames: string[];
  addedHostedTools: Array<{
    toolName?: string;
    grantStatus?: string;
  }>;
}

export interface CatalogRefreshBehaviorAnalysisInput {
  hostedToolName: string;
  grantedAgentId: string;
  ungrantedAgentId?: string;
  notices: CatalogRefreshNoticeEvidence[];
  modelContextNoticeDetected?: boolean;
  remoteMcpBoundaryOk?: boolean;
}

export interface LiveParityMatrixBehaviorAnalysisInput {
  expectedFamilyIds: string[];
  requiredPassFamilyIds?: string[];
}

export interface ToolDeveloperRepairBehaviorAnalysisInput {
  familyId?: string;
  toolName?: string;
  bucketId?: string;
}

export interface MessageHistoryToolEvidenceInput {
  agentId?: string;
  sessionId?: string;
  messages: Array<{
    id?: string;
    role: string;
    parts: Array<Record<string, unknown>>;
  }>;
}

export function defaultLiveHostedToolAcceptanceRunId(): string {
  return `live_hosted_tools_${randomUUID()}`;
}

export function resolveLiveHostedToolsDataDir(
  override = process.env["OPENACME_DATA_DIR"],
): string {
  return path.resolve(override ?? DEFAULT_LIVE_HOSTED_TOOLS_DATA_DIR);
}

export function assertLiveHostedToolsDataDirIsIsolated(
  dataDir: string,
): void {
  const resolved = path.resolve(dataDir);
  for (const forbidden of FORBIDDEN_DEFAULT_DATA_DIRS) {
    if (resolved === path.resolve(forbidden)) {
      throw new Error(
        `live hosted-tool acceptance must not run against local prod data dir ${resolved}`,
      );
    }
  }
  if (!resolved.includes(".openamce-hosted-integrations-test-env")) {
    throw new Error(
      "live hosted-tool acceptance must run against the isolated hosted integrations test env by default; " +
        `got ${resolved}`,
    );
  }
}

export function buildLiveHostedToolAcceptanceArtifact(
  input: BuildLiveHostedToolAcceptanceArtifactInput,
): LiveHostedToolAcceptanceArtifact {
  const startedAt = input.startedAt ?? new Date();
  const completedAt = input.completedAt ?? startedAt;
  const scenarios = input.scenarios ?? [];
  const preliminary = {
    schemaVersion: LIVE_HOSTED_TOOL_ACCEPTANCE_SCHEMA_VERSION,
    runId: input.runId ?? defaultLiveHostedToolAcceptanceRunId(),
    status: aggregateScenarioStatus(scenarios),
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    dataDir: path.resolve(input.dataDir),
    baseUrl: input.baseUrl,
    model: {
      provider: input.model.provider,
      model: input.model.model,
      auth: input.model.auth,
      baseUrlPresent: Boolean(input.model.baseUrl),
    },
    diagnostics: input.diagnostics ?? [],
    scenarios,
    secretScan: { status: "pass" as const, findings: [] },
  };
  const secretScan = scanLiveHostedToolAcceptanceSecrets(preliminary);
  const artifact = {
    ...preliminary,
    status:
      secretScan.status === "fail" ? ("fail" as const) : preliminary.status,
    secretScan,
  };
  return LiveHostedToolAcceptanceArtifactSchema.parse(artifact);
}

export async function writeLiveHostedToolAcceptanceArtifact(
  dataDir: string,
  artifact: LiveHostedToolAcceptanceArtifact,
): Promise<string> {
  const artifactDir = liveHostedToolAcceptanceDir(dataDir);
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, `${artifact.runId}.json`);
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2) + "\n");
  return artifactPath;
}

export async function writeLiveHostedToolAcceptanceReport(
  dataDir: string,
  artifact: LiveHostedToolAcceptanceArtifact,
  artifactPath: string,
): Promise<LiveHostedToolAcceptanceReportPaths> {
  const artifactDir = liveHostedToolAcceptanceDir(dataDir);
  await mkdir(artifactDir, { recursive: true });
  const summaryPath = path.join(artifactDir, `${artifact.runId}.summary.md`);
  const latestPath = path.join(artifactDir, "latest.json");
  await writeFile(
    summaryPath,
    renderLiveHostedToolAcceptanceSummary(artifact, artifactPath) + "\n",
  );
  await writeFile(
    latestPath,
    JSON.stringify(
      {
        schemaVersion: artifact.schemaVersion,
        runId: artifact.runId,
        status: artifact.status,
        artifactPath,
        summaryPath,
        completedAt: artifact.completedAt,
      },
      null,
      2,
    ) + "\n",
  );
  return { summaryPath, latestPath };
}

export function renderLiveHostedToolAcceptanceSummary(
  artifact: LiveHostedToolAcceptanceArtifact,
  artifactPath?: string,
): string {
  const lines: string[] = [
    `# Live Hosted-Tool Acceptance: ${artifact.runId}`,
    "",
    `Status: ${artifact.status}`,
    `Completed: ${artifact.completedAt}`,
    `Data dir: ${artifact.dataDir}`,
    ...(artifactPath ? [`Artifact: ${artifactPath}`] : []),
    "",
    "## Critical Outcomes",
    outcomeLine(
      "Tool Developer behavior",
      scenarioById(artifact, "tool-developer-loads-skill-from-live-message-history"),
    ),
    outcomeLine(
      "Business hosted invocation",
      scenarioById(artifact, "qualys-readonly-consumer-live-hosted-tool"),
      { includeRuns: true, includeGenerations: true },
    ),
    outcomeLine(
      "Denied access boundary",
      scenarioById(artifact, "qualys-readonly-consumer-live-hosted-tool"),
    ),
    outcomeLine(
      "Failure repair loop",
      scenarioById(artifact, "tool-developer-design-preserving-repair-live"),
      { includeRuns: true, includeGenerations: true, includeBuckets: true },
    ),
    outcomeLine(
      "Catalog refresh",
      scenarioById(artifact, "live-catalog-refresh-agent-settings-boundary"),
      { includeRuns: true, includeGenerations: true, includeNotices: true },
    ),
    outcomeLine(
      "Live parity matrix",
      scenarioById(artifact, "live-parity-matrix-supporting-evidence"),
      { includeParity: true },
    ),
    `- Secret scan: ${artifact.secretScan.status}${
      artifact.secretScan.findings.length > 0
        ? ` (${artifact.secretScan.findings.length} finding(s))`
        : ""
    }`,
    "",
    "## Evidence Boundary",
    "- Deterministic regression evidence: typecheck, schema tests, analyzer tests, route tests, and hosted-integrations unit tests are run separately in CI/local validation.",
    "- Live external evidence: this artifact captures real LLM/chat behavior and available live vendor parity. It is operator evidence and must not be imported by runtime product code.",
  ];

  const skippedFamilies = liveParitySkippedFamilies(artifact);
  if (skippedFamilies.length > 0) {
    lines.push("", "## Skipped Live Parity Families");
    for (const family of skippedFamilies) {
      lines.push(
        `- ${family.familyId}: ${family.diagnostics.join("; ") || "skipped without diagnostic"}`,
      );
    }
  }

  const failures = liveHostedToolAcceptanceCriticalFailures(artifact);
  if (failures.length > 0) {
    lines.push("", "## Critical Failures");
    for (const failure of failures) lines.push(`- ${failure}`);
  }

  return lines.join("\n");
}

export function liveHostedToolAcceptanceCriticalFailures(
  artifact: LiveHostedToolAcceptanceArtifact,
): string[] {
  const failures: string[] = [];
  for (const scenario of artifact.scenarios) {
    if (scenario.status === "fail") {
      failures.push(
        `${scenario.id} failed${
          scenario.diagnostics.length > 0
            ? `: ${scenario.diagnostics.join("; ")}`
            : ""
        }`,
      );
    }
  }
  if (artifact.secretScan.status === "fail") {
    failures.push(
      `secret scan failed: ${artifact.secretScan.findings
        .map((finding) => `${finding.rule} at ${finding.path}`)
        .join("; ")}`,
    );
  }
  return failures;
}

export function scanLiveHostedToolAcceptanceSecrets(
  value: unknown,
): LiveHostedToolSecretScan {
  const findings: LiveHostedToolSecretScanFinding[] = [];
  scanValue(value, "$", findings);
  return {
    status: findings.length === 0 ? "pass" : "fail",
    findings,
  };
}

export function analyzeToolDeveloperBehaviorEvidence(
  scenario: LiveHostedToolScenarioEvidence,
): ToolDeveloperBehaviorAnalysis {
  const diagnostics: string[] = [];
  const calls = scenario.toolCalls;
  if (
    !calls.some(
      (call) =>
        call.toolName === "skill_view" &&
        call.argsSummary?.["name"] === "hosted-integrations-development",
    )
  ) {
    diagnostics.push(
      "Tool Developer did not load hosted-integrations-development through skill_view",
    );
  }

  const forbiddenToolCall = calls.find((call) =>
    isForbiddenToolDeveloperTool(call.toolName),
  );
  if (forbiddenToolCall) {
    diagnostics.push(
      `Tool Developer used forbidden lifecycle tool ${forbiddenToolCall.toolName}`,
    );
  }

  const forbiddenDesignText = calls
    .map((call, index) => ({ index, text: JSON.stringify(call) }))
    .find(({ text }) => forbiddenDesignMutationPattern().test(text));
  if (forbiddenDesignText) {
    diagnostics.push(
      `Tool Developer attempted a forbidden design mutation in tool call #${forbiddenDesignText.index + 1}`,
    );
  }

  const firstMutation = calls.findIndex((call) =>
    isHostedSourceMutationTool(call.toolName),
  );
  const lockIndex = calls.findIndex(
    (call) => call.toolName === "hosted_tool_lock_acquire",
  );
  if (firstMutation >= 0 && (lockIndex < 0 || lockIndex > firstMutation)) {
    diagnostics.push("Tool Developer mutated hosted source before acquiring a lock");
  }

  const promoteIndex = calls.findIndex(
    (call) => call.toolName === "hosted_tool_promote",
  );
  if (promoteIndex >= 0) {
    const finalPatchIndex = lastIndexWhere(calls, (call) =>
      isHostedSourceMutationTool(call.toolName),
    );
    const validateIndex = lastIndexOfTool(calls, "hosted_tool_validate");
    const exampleRunIndex = lastIndexOfTool(calls, "hosted_tool_example_run");
    const readinessIndex = lastIndexOfTool(calls, "hosted_tool_readiness_get");
    if (validateIndex < finalPatchIndex || validateIndex > promoteIndex) {
      diagnostics.push(
        "Tool Developer promoted without validating after the final source/example change",
      );
    }
    if (exampleRunIndex < finalPatchIndex || exampleRunIndex > promoteIndex) {
      diagnostics.push(
        "Tool Developer promoted without running a safe example after the final source/example change",
      );
    }
    if (readinessIndex < finalPatchIndex || readinessIndex > promoteIndex) {
      diagnostics.push(
        "Tool Developer promoted without checking readiness after the final source/example change",
      );
    }
  }

  return {
    status: diagnostics.length === 0 ? "pass" : "fail",
    diagnostics,
  };
}

export function analyzeConsumerHostedToolEvidence(
  scenario: LiveHostedToolScenarioEvidence,
  input: ConsumerHostedToolBehaviorAnalysisInput,
): ToolDeveloperBehaviorAnalysis {
  const diagnostics: string[] = [];
  const calls = scenario.toolCalls;
  const helpIndex = calls.findIndex(
    (call) => call.toolName === "hosted_tool_help",
  );
  const hostedToolIndex = calls.findIndex(
    (call) => call.toolName === input.hostedToolName,
  );

  if (helpIndex < 0) {
    diagnostics.push("Consumer did not call hosted_tool_help before invocation");
  }
  if (hostedToolIndex < 0) {
    diagnostics.push(`Consumer did not call ${input.hostedToolName}`);
  }
  if (helpIndex >= 0 && hostedToolIndex >= 0 && helpIndex > hostedToolIndex) {
    diagnostics.push("Consumer called hosted business tool before hosted_tool_help");
  }

  const forbiddenToolCall = calls.find(
    (call) =>
      call.toolName.startsWith("mcp_integration-hub__") ||
      call.toolName.startsWith("managed_"),
  );
  if (forbiddenToolCall) {
    diagnostics.push(
      `Consumer used forbidden non-hosted tool ${forbiddenToolCall.toolName}`,
    );
  }

  const hostedCall = hostedToolIndex >= 0 ? calls[hostedToolIndex] : null;
  if (hostedCall?.status === "error") {
    diagnostics.push(`Consumer hosted tool call errored: ${input.hostedToolName}`);
  }
  if (hostedCall?.resultSummary?.["ok"] === false) {
    diagnostics.push(`Consumer hosted tool returned ok=false: ${input.hostedToolName}`);
  }
  const hasRunEvidence =
    scenario.runIds.length > 0 ||
    calls.some((call) => typeof call.resultSummary?.["runId"] === "string");
  if (!hasRunEvidence) {
    diagnostics.push("Consumer hosted tool evidence did not include a run id");
  }

  return {
    status: diagnostics.length === 0 ? "pass" : "fail",
    diagnostics,
  };
}

export function analyzeCatalogRefreshEvidence(
  scenario: LiveHostedToolScenarioEvidence,
  input: CatalogRefreshBehaviorAnalysisInput,
): ToolDeveloperBehaviorAnalysis {
  const diagnostics: string[] = [];
  const grantedCalls = scenario.toolCalls.filter(
    (call) => call.agentId === input.grantedAgentId,
  );
  if (!grantedCalls.some((call) => call.toolName === input.hostedToolName)) {
    diagnostics.push(
      `Granted open session did not call newly visible hosted tool ${input.hostedToolName}`,
    );
  }

  const notice = input.notices.find(
    (candidate) =>
      candidate.agentId === input.grantedAgentId &&
      candidate.addedToolNames.includes(input.hostedToolName),
  );
  if (!notice) {
    diagnostics.push(
      `Granted open session did not receive catalog notice for ${input.hostedToolName}`,
    );
  } else if (
    !notice.addedHostedTools.some(
      (tool) =>
        tool.toolName === input.hostedToolName &&
        tool.grantStatus === "granted",
    )
  ) {
    diagnostics.push(
      `Catalog notice did not mark ${input.hostedToolName} as an already granted hosted tool`,
    );
  }

  if (input.ungrantedAgentId) {
    const ungrantedCalls = scenario.toolCalls.filter(
      (call) => call.agentId === input.ungrantedAgentId,
    );
    if (
      ungrantedCalls.some((call) => call.toolName === input.hostedToolName)
    ) {
      diagnostics.push(
        `Ungranted open session called hosted tool ${input.hostedToolName}`,
      );
    }
    if (
      input.notices.some(
        (candidate) =>
          candidate.agentId === input.ungrantedAgentId &&
          candidate.addedToolNames.includes(input.hostedToolName),
      )
    ) {
      diagnostics.push(
        `Ungranted open session received catalog notice for ${input.hostedToolName}`,
      );
    }
  }

  if (input.modelContextNoticeDetected) {
    diagnostics.push("Catalog notice leaked into canonical chat message context");
  }
  if (input.remoteMcpBoundaryOk === false) {
    diagnostics.push("Remote MCP selection incorrectly enabled hosted tool access");
  }
  if (scenario.catalogNoticeIds.length === 0) {
    diagnostics.push("Catalog refresh scenario evidence did not include notice ids");
  }

  return {
    status: diagnostics.length === 0 ? "pass" : "fail",
    diagnostics,
  };
}

export function analyzeLiveParityMatrixEvidence(
  scenario: LiveHostedToolScenarioEvidence,
  input: LiveParityMatrixBehaviorAnalysisInput,
): ToolDeveloperBehaviorAnalysis {
  const diagnostics: string[] = [];
  const byFamily = new Map(
    (scenario.parityResults ?? []).map((result) => [result.familyId, result]),
  );

  for (const familyId of input.expectedFamilyIds) {
    const result = byFamily.get(familyId);
    if (!result) {
      diagnostics.push(`Live parity matrix did not report family ${familyId}`);
      continue;
    }
    if (result.status === "fail") {
      diagnostics.push(`Live parity failed for family ${familyId}`);
    }
    if (result.status === "skipped" && result.diagnostics.length === 0) {
      diagnostics.push(
        `Live parity skipped family ${familyId} without an explicit diagnostic`,
      );
    }
    if (result.status === "pass" && result.caseCount === 0) {
      diagnostics.push(
        `Live parity passed family ${familyId} without executed cases`,
      );
    }
    if (
      result.status === "pass" &&
      result.matchedCaseCount !== result.caseCount
    ) {
      diagnostics.push(
        `Live parity pass for family ${familyId} did not match every case`,
      );
    }
    if (result.artifactPath && !scenario.artifactPaths.includes(result.artifactPath)) {
      diagnostics.push(
        `Live parity artifact for family ${familyId} was not linked from scenario evidence`,
      );
    }
  }

  for (const familyId of input.requiredPassFamilyIds ?? []) {
    const result = byFamily.get(familyId);
    if (result?.status !== "pass") {
      diagnostics.push(`Live parity family ${familyId} was required to pass`);
    }
  }

  const unexpected = (scenario.parityResults ?? []).filter(
    (result) => !input.expectedFamilyIds.includes(result.familyId),
  );
  for (const result of unexpected) {
    diagnostics.push(`Live parity reported unexpected family ${result.familyId}`);
  }

  return {
    status: diagnostics.length === 0 ? "pass" : "fail",
    diagnostics,
  };
}

export function analyzeToolDeveloperRepairBehaviorEvidence(
  scenario: LiveHostedToolScenarioEvidence,
  input: ToolDeveloperRepairBehaviorAnalysisInput = {},
): ToolDeveloperBehaviorAnalysis {
  const diagnostics: string[] = [];
  const calls = scenario.toolCalls;
  if (
    !calls.some(
      (call) =>
        call.toolName === "skill_view" &&
        call.argsSummary?.["name"] === "hosted-integrations-development",
    )
  ) {
    diagnostics.push(
      "Tool Developer did not load hosted-integrations-development through skill_view",
    );
  }

  const forbiddenToolCall = calls.find((call) =>
    isForbiddenToolDeveloperTool(call.toolName),
  );
  if (forbiddenToolCall) {
    diagnostics.push(
      `Tool Developer used forbidden lifecycle tool ${forbiddenToolCall.toolName}`,
    );
  }

  const forbiddenDesignText = calls
    .map((call, index) => ({ index, text: JSON.stringify(call) }))
    .find(({ text }) => forbiddenDesignMutationPattern().test(text));
  if (forbiddenDesignText) {
    diagnostics.push(
      `Tool Developer attempted a forbidden design mutation in tool call #${forbiddenDesignText.index + 1}`,
    );
  }

  const firstMutation = calls.findIndex((call) =>
    isHostedSourceMutationTool(call.toolName),
  );
  const lockIndex = calls.findIndex(
    (call) => call.toolName === "hosted_tool_lock_acquire",
  );
  if (firstMutation >= 0 && (lockIndex < 0 || lockIndex > firstMutation)) {
    diagnostics.push("Tool Developer mutated hosted source before acquiring a lock");
  }

  const runGetIndex = firstIndexOfTool(calls, "hosted_tool_run_get");
  const bucketIndex = firstIndexWhere(calls, (call) =>
    ["hosted_tool_failure_bucket_get", "hosted_tool_failure_bucket_list"].includes(
      call.toolName,
    ),
  );
  const sourceViewIndex = firstIndexOfTool(calls, "hosted_tool_source_view");
  if (runGetIndex < 0) {
    diagnostics.push("Tool Developer did not inspect the failing hosted run");
  }
  if (bucketIndex < 0) {
    diagnostics.push("Tool Developer did not inspect the failure bucket");
  }
  if (sourceViewIndex < 0) {
    diagnostics.push("Tool Developer did not inspect focused source view");
  }
  if (firstMutation >= 0) {
    if (runGetIndex < 0 || runGetIndex > firstMutation) {
      diagnostics.push("Tool Developer patched before inspecting the failing run");
    }
    if (bucketIndex < 0 || bucketIndex > firstMutation) {
      diagnostics.push("Tool Developer patched before inspecting the failure bucket");
    }
    if (sourceViewIndex < 0 || sourceViewIndex > firstMutation) {
      diagnostics.push("Tool Developer patched before inspecting focused source");
    }
  }

  const regressionIndex = calls.findIndex(
    (call) =>
      (call.toolName === "hosted_tool_example_upsert" &&
        (call.argsSummary?.["category"] === "regression" ||
          JSON.stringify(call.argsSummary ?? {}).includes("regression") ||
          call.resultSummary?.["ok"] === true)) ||
      (call.toolName === "hosted_tool_example_run" &&
        JSON.stringify(call.argsSummary ?? {}).includes("regression")),
  );
  if (regressionIndex < 0) {
    diagnostics.push("Tool Developer did not add a regression example");
  }

  const promoteIndex = firstIndexOfTool(calls, "hosted_tool_promote");
  const finalMutation = lastIndexWhere(calls, (call) =>
    isHostedSourceMutationTool(call.toolName),
  );
  const validateIndex = lastIndexOfTool(calls, "hosted_tool_validate");
  if (promoteIndex < 0) {
    diagnostics.push("Tool Developer did not promote the repaired generation");
  } else {
    if (validateIndex < finalMutation || validateIndex > promoteIndex) {
      diagnostics.push(
        "Tool Developer promoted repair without validating after the final source/example change",
      );
    }
    if (regressionIndex < 0 || regressionIndex > promoteIndex) {
      diagnostics.push(
        "Tool Developer promoted repair without adding the regression example first",
      );
    }
  }

  const debugRunIndex = firstIndexOfTool(calls, "hosted_tool_debug_run");
  if (debugRunIndex < 0) {
    diagnostics.push("Tool Developer did not debug-run the repaired generation");
  } else {
    const debugRun = calls[debugRunIndex];
    if (debugRun?.resultSummary?.["ok"] === false) {
      diagnostics.push("Tool Developer debug-run of repaired generation failed");
    }
    if (promoteIndex >= 0 && debugRunIndex < promoteIndex) {
      diagnostics.push("Tool Developer debug-ran before promoting the repair");
    }
  }

  const closeIndex = firstIndexOfTool(calls, "hosted_tool_failure_bucket_close");
  if (closeIndex < 0) {
    diagnostics.push("Tool Developer did not close the failure bucket");
  } else {
    const closeCall = calls[closeIndex];
    if (debugRunIndex >= 0 && closeIndex < debugRunIndex) {
      diagnostics.push("Tool Developer closed the bucket before debug proof");
    }
    if (input.bucketId && closeCall?.argsSummary?.["bucket_id"] !== input.bucketId) {
      diagnostics.push("Tool Developer closed a different failure bucket");
    }
    if (typeof closeCall?.argsSummary?.["generation_id"] !== "string") {
      diagnostics.push("Tool Developer closed bucket without generation evidence");
    }
    if (typeof closeCall?.argsSummary?.["regression_example_id"] !== "string") {
      diagnostics.push(
        "Tool Developer closed bucket without regression example evidence",
      );
    }
    if (closeCall?.resultSummary?.["ok"] === false) {
      diagnostics.push("Tool Developer failure bucket close was rejected");
    }
  }

  if (scenario.failureBucketIds.length === 0) {
    diagnostics.push("Repair scenario evidence did not include a failure bucket id");
  }
  if (scenario.runIds.length === 0) {
    diagnostics.push("Repair scenario evidence did not include hosted run evidence");
  }
  if (scenario.generationIds.length === 0) {
    diagnostics.push("Repair scenario evidence did not include repaired generation id");
  }

  const familyId = input.familyId;
  if (
    familyId &&
    !calls.some((call) => JSON.stringify(call.argsSummary ?? {}).includes(familyId))
  ) {
    diagnostics.push(`Repair transcript did not reference family ${familyId}`);
  }
  const toolName = input.toolName;
  if (
    toolName &&
    !calls.some((call) => JSON.stringify(call.argsSummary ?? {}).includes(toolName))
  ) {
    diagnostics.push(`Repair transcript did not reference tool ${toolName}`);
  }

  return {
    status: diagnostics.length === 0 ? "pass" : "fail",
    diagnostics,
  };
}

export function extractLiveHostedToolCallsFromMessageHistory(
  input: MessageHistoryToolEvidenceInput,
): LiveHostedToolCallEvidence[] {
  const calls: LiveHostedToolCallEvidence[] = [];
  for (const message of input.messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      const type = part["type"];
      if (typeof type !== "string" || !type.startsWith("tool-")) continue;
      const toolName = type.slice("tool-".length);
      const argsSummary = toolPartInputSummary(part);
      const resultSummary = toolPartOutputSummary(part);
      calls.push({
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(message.id ? { messageId: message.id } : {}),
        toolName,
        status: toolPartStatus(part),
        ...(argsSummary ? { argsSummary } : {}),
        ...(resultSummary ? { resultSummary } : {}),
      });
    }
  }
  return calls;
}

function aggregateScenarioStatus(
  scenarios: readonly LiveHostedToolScenarioEvidence[],
): LiveHostedToolAcceptanceStatus {
  if (scenarios.some((scenario) => scenario.status === "fail")) return "fail";
  if (scenarios.length > 0 && scenarios.every((s) => s.status === "skipped")) {
    return "skipped";
  }
  return "pass";
}

function liveHostedToolAcceptanceDir(dataDir: string): string {
  return path.join(dataDir, "hosted-integrations", "live-acceptance");
}

function scenarioById(
  artifact: LiveHostedToolAcceptanceArtifact,
  id: string,
): LiveHostedToolScenarioEvidence | undefined {
  return artifact.scenarios.find((scenario) => scenario.id === id);
}

function outcomeLine(
  label: string,
  scenario: LiveHostedToolScenarioEvidence | undefined,
  options: {
    includeRuns?: boolean;
    includeGenerations?: boolean;
    includeBuckets?: boolean;
    includeNotices?: boolean;
    includeParity?: boolean;
  } = {},
): string {
  if (!scenario) return `- ${label}: missing`;
  const evidence: string[] = [];
  if (scenario.sessionIds.length > 0) {
    evidence.push(`sessions ${scenario.sessionIds.join(", ")}`);
  }
  if (options.includeRuns && scenario.runIds.length > 0) {
    evidence.push(`runs ${scenario.runIds.join(", ")}`);
  }
  if (options.includeGenerations && scenario.generationIds.length > 0) {
    evidence.push(`generations ${scenario.generationIds.join(", ")}`);
  }
  if (options.includeBuckets && scenario.failureBucketIds.length > 0) {
    evidence.push(`buckets ${scenario.failureBucketIds.join(", ")}`);
  }
  if (options.includeNotices && scenario.catalogNoticeIds.length > 0) {
    evidence.push(`notices ${scenario.catalogNoticeIds.join(", ")}`);
  }
  if (options.includeParity && (scenario.parityResults ?? []).length > 0) {
    evidence.push(
      `families ${(scenario.parityResults ?? [])
        .map((result) => `${result.familyId}:${result.status}`)
        .join(", ")}`,
    );
  }
  return `- ${label}: ${scenario.status}${
    evidence.length > 0 ? ` (${evidence.join("; ")})` : ""
  }`;
}

function liveParitySkippedFamilies(
  artifact: LiveHostedToolAcceptanceArtifact,
): LiveHostedToolParityResult[] {
  return artifact.scenarios
    .flatMap((scenario) => scenario.parityResults ?? [])
    .filter((result) => result.status === "skipped");
}

function isForbiddenToolDeveloperTool(toolName: string): boolean {
  if (toolName === "skill_view") return false;
  if (toolName.startsWith("hosted_tool_")) return false;
  return true;
}

function isHostedSourceMutationTool(toolName: string): boolean {
  return [
    "hosted_tool_draft_create",
    "hosted_tool_draft_patch",
    "hosted_tool_draft_delete",
    "hosted_tool_example_upsert",
  ].includes(toolName);
}

function lastIndexOfTool(
  calls: readonly LiveHostedToolCallEvidence[],
  toolName: string,
): number {
  return lastIndexWhere(calls, (call) => call.toolName === toolName);
}

function firstIndexOfTool(
  calls: readonly LiveHostedToolCallEvidence[],
  toolName: string,
): number {
  return firstIndexWhere(calls, (call) => call.toolName === toolName);
}

function firstIndexWhere<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): number {
  for (let index = 0; index < values.length; index += 1) {
    if (predicate(values[index] as T)) return index;
  }
  return -1;
}

function lastIndexWhere<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index] as T)) return index;
  }
  return -1;
}

function forbiddenDesignMutationPattern(): RegExp {
  return /\b(?:handlerDispatch|legacy_call_tool|call_tool\s*\(|configScopeId|allowedConfigScopeIds|defaultConfigScopeId|managed_[a-z0-9_]+__|mcp_integration-hub__|demo environment|parity environment|qualys-live-demo|qualys-live-parity)\b/i;
}

function toolPartStatus(
  part: Record<string, unknown>,
): LiveHostedToolCallEvidence["status"] {
  const state = part["state"];
  if (state === "output-available") return "output";
  if (state === "output-error" || state === "error") return "error";
  return "called";
}

function toolPartInputSummary(
  part: Record<string, unknown>,
): Record<string, unknown> | null {
  return objectSummary(part["input"] ?? part["args"] ?? part["arguments"]);
}

function toolPartOutputSummary(
  part: Record<string, unknown>,
): Record<string, unknown> | null {
  const raw = part["output"] ?? part["result"] ?? part["content"];
  if (typeof raw === "string") {
    try {
      return objectSummary(JSON.parse(raw));
    } catch {
      return { text: raw.slice(0, 240) };
    }
  }
  return objectSummary(raw);
}

function objectSummary(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item && typeof item === "object") {
      out[key] = Array.isArray(item)
        ? `[array:${item.length}]`
        : nestedDiagnosticSummary(key, item);
    } else if (typeof item === "string" && item.length > 240) {
      out[key] = `${item.slice(0, 237)}...`;
    } else {
      out[key] = item;
    }
  }
  return out;
}

function nestedDiagnosticSummary(key: string, value: object): unknown {
  if (!["error", "readiness", "policy", "diagnostics"].includes(key)) {
    return "[object]";
  }
  return objectSummary(value) ?? "[object]";
}

function scanValue(
  value: unknown,
  currentPath: string,
  findings: LiveHostedToolSecretScanFinding[],
): void {
  if (typeof value === "string") {
    scanString(value, currentPath, findings);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      scanValue(item, `${currentPath}[${index}]`, findings),
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const childPath = `${currentPath}.${key}`;
      if (isSecretKey(key) && typeof item === "string" && !isRedacted(item)) {
        findings.push({
          path: childPath,
          rule: "secret-key-value",
          excerpt: redactExcerpt(item),
        });
      }
      scanValue(item, childPath, findings);
    }
  }
}

function scanString(
  value: string,
  currentPath: string,
  findings: LiveHostedToolSecretScanFinding[],
): void {
  const rules: Array<{ name: string; pattern: RegExp }> = [
    { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
    {
      name: "access-token-assignment",
      pattern: /\baccess_token\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i,
    },
    {
      name: "jwt-token",
      pattern:
        /\beyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{20,}){0,2}\b/,
    },
    {
      name: "secret-assignment",
      pattern:
        /\b(?:client_secret|password|token|api[_-]?key)\b\s*[:=]\s*["']?[^"',\s]{8,}/i,
    },
    {
      name: "vendor-secret-assignment",
      pattern:
        /\b(?:QUALYS_PASSWORD|QUALYS_USERNAME|SPLUNK_TOKEN|MSGRAPH_CLIENT_SECRET|MDE_CLIENT_SECRET|DEFENDER_CLIENT_SECRET)\b\s*[:=]\s*["']?[^"',\s]{8,}/,
    },
    { name: "raw-secret-sentinel", pattern: /\braw-secret\b/i },
  ];
  for (const rule of rules) {
    const match = value.match(rule.pattern);
    if (!match) continue;
    findings.push({
      path: currentPath,
      rule: rule.name,
      excerpt: redactExcerpt(match[0] ?? value),
    });
  }
}

function isSecretKey(key: string): boolean {
  return /(?:password|token|secret|api[_-]?key)$/i.test(key);
}

function isRedacted(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "[redacted]" ||
    normalized === "<redacted>" ||
    normalized === "***" ||
    normalized === "redacted"
  );
}

function redactExcerpt(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return "[redacted]";
  return `${trimmed.slice(0, 4)}...[redacted]...${trimmed.slice(-2)}`;
}
