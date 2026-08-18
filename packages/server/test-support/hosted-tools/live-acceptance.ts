import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const LIVE_HOSTED_TOOL_ACCEPTANCE_SCHEMA_VERSION =
  "2026-08-18.live-hosted-tool-acceptance.v2";
export const LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION =
  "2026-08-18.hosted-tool-live-evaluation-scenarios.v1";

export const DEFAULT_LIVE_HOSTED_TOOLS_DATA_DIR = path.join(
  homedir(),
  ".openamce-hosted-integrations-test-env",
);

export const LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME = "integration-hub";
export const ACCEPTED_LIVE_ARTIFACT_PATH_PREFIX =
  "~/.openamce-hosted-integrations-test-env/hosted-integrations/live-acceptance/";

export const HOSTED_ONLY_LIVE_AGENT_MCP_DISABLED = [
  LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME,
] as const;

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

export const LiveHostedToolMessagePartEvidenceSchema = z
  .object({
    type: z.string().min(1),
    text: z.string().optional(),
    toolName: z.string().optional(),
    state: z.string().optional(),
    inputSummary: z.record(z.string(), z.unknown()).optional(),
    outputSummary: z.record(z.string(), z.unknown()).optional(),
    dataSummary: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type LiveHostedToolMessagePartEvidence = z.infer<
  typeof LiveHostedToolMessagePartEvidenceSchema
>;

export const LiveHostedToolMessageEvidenceSchema = z
  .object({
    id: z.string().optional(),
    role: z.string().min(1),
    parts: z.array(LiveHostedToolMessagePartEvidenceSchema).default([]),
  })
  .strict();
export type LiveHostedToolMessageEvidence = z.infer<
  typeof LiveHostedToolMessageEvidenceSchema
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

export const LiveHostedToolGuidanceSchema = z.enum([
  "prompt_guided",
  "operator_instrumented",
  "unguided",
]);
export type LiveHostedToolGuidance = z.infer<
  typeof LiveHostedToolGuidanceSchema
>;

export const LiveHostedToolExpectedOutcomeSchema = z.enum([
  "hosted_call",
  "evidence_required",
  "refusal",
  "recovery",
]);
export type LiveHostedToolExpectedOutcome = z.infer<
  typeof LiveHostedToolExpectedOutcomeSchema
>;

export const LiveHostedToolScenarioEvidenceSchema = z
  .object({
    id: z.string().min(1),
    guidance: LiveHostedToolGuidanceSchema.default("prompt_guided"),
    expectedOutcome: LiveHostedToolExpectedOutcomeSchema.optional(),
    status: LiveHostedToolAcceptanceStatusSchema,
    diagnostics: z.array(z.string()).default([]),
    prompts: z.array(z.string()).default([]),
    agentIds: z.array(z.string()).default([]),
    sessionIds: z.array(z.string()).default([]),
    messageIds: z.array(z.string()).default([]),
    messageHistory: z.array(LiveHostedToolMessageEvidenceSchema).default([]),
    outcomeText: z.string().optional(),
    toolCalls: z.array(LiveHostedToolCallEvidenceSchema).default([]),
    availableToolNames: z.array(z.string()).default([]),
    preInvocationHelpParameterNames: z.array(z.string()).default([]),
    generationIds: z.array(z.string()).default([]),
    runIds: z.array(z.string()).default([]),
    failureBucketIds: z.array(z.string()).default([]),
    catalogNoticeIds: z.array(z.string()).default([]),
    parityResults: z.array(LiveHostedToolParityResultSchema).default([]),
    artifactPaths: z.array(z.string()).default([]),
    mcpDisabled: z.array(z.string()).default([]),
  })
  .strict();
export type LiveHostedToolScenarioEvidence = Omit<
  z.infer<typeof LiveHostedToolScenarioEvidenceSchema>,
  | "guidance"
  | "parityResults"
  | "mcpDisabled"
  | "availableToolNames"
  | "preInvocationHelpParameterNames"
  | "messageHistory"
> & {
  guidance?: LiveHostedToolGuidance;
  parityResults?: LiveHostedToolParityResult[];
  mcpDisabled?: string[];
  availableToolNames?: string[];
  preInvocationHelpParameterNames?: string[];
  messageHistory?: LiveHostedToolMessageEvidence[];
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
  expectedOutcome?: LiveHostedToolExpectedOutcome;
  requireUnguided?: boolean;
  requireHostedHelp?: boolean;
  requireDetailedHelpOrVocabularyLookup?: boolean;
  forbiddenHostedToolNames?: string[];
  forbiddenHostedArgumentFragments?: string[];
  requiredHostedArgumentFragments?: string[];
  requiredHelpParameterNames?: string[];
  requiredHostedResultFragments?: string[];
  requiredHostedResultSummaryKeys?: string[];
  forbiddenOutcomeFragments?: string[];
  requiredOutcomeFragments?: string[];
  requiredDisabledMcpServers?: string[];
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

export interface MessageHistoryOutcomeTextInput {
  messages: Array<{
    role: string;
    parts: Array<Record<string, unknown>>;
  }>;
  maxChars?: number;
}

export interface MessageHistoryUpstreamErrorDiagnosticsInput {
  messages: Array<{
    role: string;
    parts: Array<Record<string, unknown>>;
  }>;
  maxChars?: number;
}

export interface UnguidedConsumerPromptLintFinding {
  rule: string;
  excerpt: string;
}

export interface UnguidedConsumerPromptLintResult {
  status: "pass" | "fail";
  findings: UnguidedConsumerPromptLintFinding[];
}

function addDuplicateStringIssues(input: {
  ctx: z.RefinementCtx;
  values: string[];
  pathPrefix: Array<string | number>;
  label: string;
}): void {
  const seen = new Set<string>();
  for (const [index, value] of input.values.entries()) {
    if (seen.has(value)) {
      input.ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...input.pathPrefix, index],
        message: `duplicate live hosted-tool evaluation ${input.label} value ${value}`,
      });
    }
    seen.add(value);
  }
}

export const LiveHostedToolEvaluationScenarioSchema = z
  .object({
    id: z.string().min(1),
    execution: z.enum(["active", "planned"]).default("active"),
    coverage: z.array(z.string().min(1)).min(1),
    expectedOutcome: LiveHostedToolExpectedOutcomeSchema,
    familyId: z.string().min(1),
    preferredToolName: z.string().min(1),
    availableToolNames: z.array(z.string().min(1)).default([]),
    acceptedArtifacts: z
      .array(
        z
          .object({
            runId: z.string().min(1),
            path: z.string().min(1),
            status: z.literal("pass"),
            secretScan: z.literal("pass"),
            evidence: z
              .string()
              .min(1)
              .max(240)
              .refine((value) => !/[\r\n]/.test(value), {
                message:
                  "Accepted live artifact evidence must be a single-line summary",
              }),
          })
          .strict(),
      )
      .default([]),
    guidance: LiveHostedToolGuidanceSchema,
    agent: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        role: z.string().min(1),
        persona: z.string().min(1),
      })
      .strict(),
    prompt: z.string().min(1),
    analyzer: z
      .object({
        requireUnguided: z.boolean().default(false),
        requireHostedHelp: z.boolean().default(true),
        requireDetailedHelpOrVocabularyLookup: z.boolean().default(false),
        forbiddenToolNames: z.array(z.string().min(1)).default([]),
        forbiddenHostedArgumentFragments: z.array(z.string().min(1)).default([]),
        requiredHostedArgumentFragments: z.array(z.string().min(1)).default([]),
        requiredHelpParameterNames: z.array(z.string().min(1)).default([]),
        requiredHostedResultFragments: z.array(z.string().min(1)).default([]),
        requiredHostedResultSummaryKeys: z.array(z.string().min(1)).default([]),
        forbiddenOutcomeFragments: z.array(z.string().min(1)).default([]),
        requiredOutcomeFragments: z.array(z.string().min(1)).default([]),
        requiredDisabledMcpServers: z.array(z.string().min(1)).default([]),
      })
      .strict(),
  })
  .strict()
  .superRefine((scenario, ctx) => {
    if (scenario.familyId !== "qualys" || scenario.guidance !== "unguided") {
      return;
    }
    for (const field of [
      "forbiddenToolNames",
      "forbiddenHostedArgumentFragments",
      "requiredHostedArgumentFragments",
      "requiredHelpParameterNames",
      "requiredHostedResultFragments",
      "requiredHostedResultSummaryKeys",
      "forbiddenOutcomeFragments",
      "requiredOutcomeFragments",
      "requiredDisabledMcpServers",
    ] as const) {
      addDuplicateStringIssues({
        ctx,
        values: scenario.analyzer[field],
        pathPrefix: ["analyzer", field],
        label: `analyzer.${field}`,
      });
    }
    const candidateToolNames = new Set<string>();
    for (const [index, toolName] of scenario.availableToolNames.entries()) {
      if (candidateToolNames.has(toolName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["availableToolNames", index],
          message: `duplicate live hosted-tool evaluation candidate tool ${toolName}`,
        });
      }
      candidateToolNames.add(toolName);
    }
    if (
      scenario.availableToolNames.length > 0 &&
      !scenario.availableToolNames.includes(scenario.preferredToolName)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["availableToolNames"],
        message:
          "Scenario candidate tools must include the preferred tool when candidate tools are declared",
      });
    }
    if (!scenario.analyzer.requireUnguided) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["analyzer", "requireUnguided"],
        message: "Qualys unguided scenarios must require unguided analysis",
      });
    }
    for (const finding of lintUnguidedConsumerPrompt(scenario.prompt).findings) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompt"],
        message: `Unguided Qualys scenario prompt contains ${finding.rule}`,
      });
    }
    if (
      !scenario.analyzer.requiredDisabledMcpServers.includes(
        LEGACY_INTEGRATION_HUB_MCP_SERVER_NAME,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["analyzer", "requiredDisabledMcpServers"],
        message:
          "Qualys unguided scenarios must disable the legacy integration-hub MCP server",
      });
    }
    if (
      scenario.execution === "active" &&
      scenario.acceptedArtifacts.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acceptedArtifacts"],
        message:
          "Active unguided Qualys scenarios must record accepted live artifact evidence",
      });
    }
    if (
      scenario.execution === "planned" &&
      scenario.acceptedArtifacts.length > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acceptedArtifacts"],
        message:
          "Planned unguided Qualys scenarios must not record accepted artifact evidence until promoted to active",
      });
    }
    for (const [index, artifact] of scenario.acceptedArtifacts.entries()) {
      if (!artifact.path.startsWith(ACCEPTED_LIVE_ARTIFACT_PATH_PREFIX)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["acceptedArtifacts", index, "path"],
          message:
            "Accepted live artifact paths must point at the hosted integrations test environment live-acceptance evidence directory",
        });
      }
      if (!artifact.path.endsWith(".json")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["acceptedArtifacts", index, "path"],
          message: "Accepted live artifact paths must reference JSON artifacts",
        });
      }
      if (
        artifact.path !==
        `${ACCEPTED_LIVE_ARTIFACT_PATH_PREFIX}${artifact.runId}.json`
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["acceptedArtifacts", index, "runId"],
          message:
            "Accepted live artifact runId must match the JSON artifact filename directly under the evidence directory",
        });
      }
    }
    if (
      scenario.coverage.includes("provider_evidence_boundary") &&
      scenario.expectedOutcome !== "evidence_required"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedOutcome"],
        message:
          "Provider-evidence-boundary scenarios must expect evidence_required",
      });
    }
    if (
      scenario.coverage.includes("mutating_scoped_out_refusal") &&
      scenario.expectedOutcome !== "refusal"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedOutcome"],
        message: "Mutating scoped-out scenarios must expect refusal",
      });
    }
    if (
      (scenario.coverage.includes("validation_error_recovery") ||
        scenario.coverage.includes("auth_rate_limit_recovery")) &&
      scenario.expectedOutcome !== "recovery"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedOutcome"],
        message: "Recovery scenarios must expect recovery",
      });
    }
    if (
      scenario.coverage.includes("overlapping_tool_selection") &&
      new Set([scenario.preferredToolName, ...scenario.availableToolNames])
        .size < 2
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["availableToolNames"],
        message:
          "Overlapping-tool-selection scenarios must expose more than one candidate tool",
      });
    }
    if (
      scenario.coverage.includes("avoid_unnecessary_search") &&
      scenario.analyzer.forbiddenToolNames.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["analyzer", "forbiddenToolNames"],
        message:
          "Avoid-unnecessary-search scenarios must declare forbidden discovery tools",
      });
    }
    for (const [index, toolName] of scenario.analyzer.forbiddenToolNames.entries()) {
      if (toolName.startsWith("hosted_")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["analyzer", "forbiddenToolNames", index],
          message:
            "Forbidden tool names in live scenario manifests must be family-native tool names, not hosted MCP names",
        });
      }
    }
    if (
      scenario.coverage.includes("gav_filter_construction") &&
      !scenario.coverage.includes("qps_count_download_argument_rules") &&
      !scenario.analyzer.requiredHostedArgumentFragments.includes(
        "qualys.agent.lastCheckedInDate",
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["analyzer", "requiredHostedArgumentFragments"],
        message:
          "GAV filter-construction scenarios must require canonical last-check-in field evidence",
      });
    }
    for (const cutoff of scenario.prompt.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g) ??
      []) {
      if (!scenario.analyzer.requiredHostedArgumentFragments.includes(cutoff)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["analyzer", "requiredHostedArgumentFragments"],
          message:
            "Scenarios that name a timestamp cutoff must require that exact cutoff in hosted argument evidence",
        });
      }
    }
    if (
      (scenario.coverage.includes("gav_filter_construction") ||
        scenario.coverage.includes("qps_filter_construction") ||
        scenario.coverage.includes("help_vocabulary_discovery")) &&
      !scenario.analyzer.requiredHelpParameterNames.includes(
        "filter_body.filters.field",
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["analyzer", "requiredHelpParameterNames"],
        message:
          "GAV filter-construction and vocabulary-discovery scenarios must require help evidence for filter_body.filters.field",
      });
    }
    if (
      scenario.coverage.includes("collection_limit") &&
      !scenario.analyzer.requiredHostedArgumentFragments.includes("page_size")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["analyzer", "requiredHostedArgumentFragments"],
        message: "Collection-limit scenarios must require page_size evidence",
      });
    }
    if (scenario.coverage.includes("pagination_continuation")) {
      for (const fragment of ["page_size", "max_pages"]) {
        if (!scenario.analyzer.requiredHostedArgumentFragments.includes(fragment)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["analyzer", "requiredHostedArgumentFragments"],
            message:
              "Pagination-continuation scenarios must require page_size and max_pages evidence",
          });
          break;
        }
      }
      if (
        !scenario.analyzer.requiredHostedResultSummaryKeys.includes(
          "result.next_last_seen_asset_id",
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["analyzer", "requiredHostedResultSummaryKeys"],
          message:
            "Pagination-continuation scenarios must require next_last_seen_asset_id result evidence",
        });
      }
      if (
        !scenario.analyzer.requiredHostedResultSummaryKeys.includes(
          "result.truncated",
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["analyzer", "requiredHostedResultSummaryKeys"],
          message:
            "Pagination-continuation scenarios must require truncated result evidence",
        });
      }
    }
    if (
      scenario.coverage.includes("artifact_result_path_inspection") &&
      !scenario.analyzer.requiredHostedResultSummaryKeys.includes(
        "resultPathInspected",
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["analyzer", "requiredHostedResultSummaryKeys"],
        message:
          "Artifact-result-path scenarios must require resultPathInspected evidence",
      });
    }
    if (
      scenario.coverage.includes("qps_count_download_argument_rules") &&
      !scenario.analyzer.forbiddenHostedArgumentFragments.includes("limit")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["analyzer", "forbiddenHostedArgumentFragments"],
        message:
          "QPS count/download scenarios must forbid limit argument evidence",
      });
    }
    if (scenario.coverage.includes("qps_filter_construction")) {
      for (const fragment of ["operatingSystem.category2", "Server"]) {
        if (
          !scenario.analyzer.requiredHostedArgumentFragments.includes(fragment)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["analyzer", "requiredHostedArgumentFragments"],
            message:
              "QPS filter-construction scenarios must require server operating-system filter evidence",
          });
          break;
        }
      }
    }
    if (
      scenario.coverage.includes("confirmation_boundary") &&
      scenario.analyzer.forbiddenOutcomeFragments.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["analyzer", "forbiddenOutcomeFragments"],
        message:
          "Confirmation-boundary scenarios must forbid successful mutation outcome claims",
      });
    }
    if (
      scenario.expectedOutcome !== "hosted_call" &&
      scenario.analyzer.requiredOutcomeFragments.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["analyzer", "requiredOutcomeFragments"],
        message:
          "Non-call outcome scenarios must require positive outcome text evidence",
      });
    }
  });
export type LiveHostedToolEvaluationScenario = z.infer<
  typeof LiveHostedToolEvaluationScenarioSchema
>;
export type LiveHostedToolAcceptedArtifactClaim =
  LiveHostedToolEvaluationScenario["acceptedArtifacts"][number];

export interface AnalyzeAcceptedLiveHostedToolArtifactClaimInput {
  scenario: LiveHostedToolEvaluationScenario;
  acceptedArtifact: LiveHostedToolAcceptedArtifactClaim;
  artifact: LiveHostedToolAcceptanceArtifact;
}

export interface AnalyzeAcceptedLiveHostedToolArtifactClaimsInput {
  manifest: LiveHostedToolEvaluationScenarioManifest;
  scenarios?: LiveHostedToolEvaluationScenario[];
  readArtifact?: (artifactPath: string) => Promise<unknown>;
}

export function analyzeAcceptedLiveHostedToolArtifactClaim(
  input: AnalyzeAcceptedLiveHostedToolArtifactClaimInput,
): string[] {
  const diagnostics: string[] = [];
  const { scenario, acceptedArtifact, artifact } = input;

  if (acceptedArtifact.runId !== artifact.runId) {
    diagnostics.push(
      `accepted artifact runId ${acceptedArtifact.runId} does not match parsed artifact runId ${artifact.runId}`,
    );
  }
  if (artifact.status !== "pass") {
    diagnostics.push(
      `accepted artifact ${acceptedArtifact.runId} status is ${artifact.status}, expected pass`,
    );
  }
  if (artifact.secretScan.status !== "pass") {
    diagnostics.push(
      `accepted artifact ${acceptedArtifact.runId} secret scan is ${artifact.secretScan.status}, expected pass`,
    );
  }
  if (artifact.secretScan.findings.length > 0) {
    diagnostics.push(
      `accepted artifact ${acceptedArtifact.runId} has ${artifact.secretScan.findings.length} secret scan finding(s)`,
    );
  }

  const scenarioEvidence = artifact.scenarios.find(
    (candidate) => candidate.id === scenario.id,
  );
  if (!scenarioEvidence) {
    diagnostics.push(
      `accepted artifact ${acceptedArtifact.runId} does not contain scenario ${scenario.id}`,
    );
    return diagnostics;
  }

  if (scenarioEvidence.status !== "pass") {
    diagnostics.push(
      `accepted scenario ${scenario.id} status is ${scenarioEvidence.status}, expected pass`,
    );
  }
  if (!scenarioEvidence.expectedOutcome) {
    diagnostics.push(
      `accepted scenario ${scenario.id} is missing expectedOutcome evidence, manifest expects ${scenario.expectedOutcome}`,
    );
  }
  if (
    scenarioEvidence.expectedOutcome &&
    scenarioEvidence.expectedOutcome !== scenario.expectedOutcome
  ) {
    diagnostics.push(
      `accepted scenario ${scenario.id} expectedOutcome is ${scenarioEvidence.expectedOutcome}, manifest expects ${scenario.expectedOutcome}`,
    );
  }
  const hostedToolName = `hosted_${scenario.familyId}__${scenario.preferredToolName}`;
  const behaviorAnalysis = analyzeConsumerHostedToolEvidence(scenarioEvidence, {
    hostedToolName,
    expectedOutcome: scenario.expectedOutcome,
    requireUnguided: scenario.analyzer.requireUnguided,
    requireHostedHelp: scenario.analyzer.requireHostedHelp,
    requireDetailedHelpOrVocabularyLookup:
      scenario.analyzer.requireDetailedHelpOrVocabularyLookup,
    forbiddenHostedToolNames: scenario.analyzer.forbiddenToolNames.map(
      (toolName) => `hosted_${scenario.familyId}__${toolName}`,
    ),
    forbiddenHostedArgumentFragments:
      scenario.analyzer.forbiddenHostedArgumentFragments,
    requiredHostedArgumentFragments:
      scenario.analyzer.requiredHostedArgumentFragments,
    requiredHelpParameterNames: scenario.analyzer.requiredHelpParameterNames,
    requiredHostedResultFragments:
      scenario.analyzer.requiredHostedResultFragments,
    requiredHostedResultSummaryKeys:
      scenario.analyzer.requiredHostedResultSummaryKeys,
    forbiddenOutcomeFragments: scenario.analyzer.forbiddenOutcomeFragments,
    requiredOutcomeFragments: scenario.analyzer.requiredOutcomeFragments,
    requiredDisabledMcpServers: scenario.analyzer.requiredDisabledMcpServers,
  });
  diagnostics.push(
    ...behaviorAnalysis.diagnostics.map(
      (diagnostic) => `accepted scenario ${scenario.id}: ${diagnostic}`,
    ),
  );
  return diagnostics;
}

export async function analyzeAcceptedLiveHostedToolArtifactClaims(
  input: AnalyzeAcceptedLiveHostedToolArtifactClaimsInput,
): Promise<string[]> {
  const diagnostics: string[] = [];
  const scenarios =
    input.scenarios ??
    input.manifest.scenarios.filter(
      (scenario) => scenario.execution === "active",
    );
  const readArtifact =
    input.readArtifact ??
    (async (artifactPath: string): Promise<unknown> => {
      const raw = await readFile(expandHomePath(artifactPath), "utf-8");
      return JSON.parse(raw) as unknown;
    });

  for (const scenario of scenarios) {
    if (
      scenario.execution === "active" &&
      scenario.acceptedArtifacts.length === 0
    ) {
      diagnostics.push(
        `active scenario ${scenario.id} has no accepted artifact claim`,
      );
      continue;
    }
    for (const acceptedArtifact of scenario.acceptedArtifacts) {
      let parsed: LiveHostedToolAcceptanceArtifact;
      try {
        const rawArtifact = await readArtifact(acceptedArtifact.path);
        parsed = LiveHostedToolAcceptanceArtifactSchema.parse(rawArtifact);
      } catch (error) {
        diagnostics.push(
          `could not read accepted artifact ${acceptedArtifact.runId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      diagnostics.push(
        ...analyzeAcceptedLiveHostedToolArtifactClaim({
          scenario,
          acceptedArtifact,
          artifact: parsed,
        }),
      );
    }
  }

  return diagnostics;
}

export const LiveHostedToolEvaluationScenarioManifestSchema = z
  .object({
    schemaVersion: z.literal(
      LIVE_HOSTED_TOOL_EVALUATION_SCENARIOS_SCHEMA_VERSION,
    ),
    scenarios: z.array(LiveHostedToolEvaluationScenarioSchema).min(1),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const seenScenarioIds = new Map<string, number>();
    for (const [index, scenario] of manifest.scenarios.entries()) {
      const firstIndex = seenScenarioIds.get(scenario.id);
      if (firstIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scenarios", index, "id"],
          message: `duplicate live hosted-tool evaluation scenario id ${scenario.id}; first seen at scenarios.${firstIndex}.id`,
        });
      } else {
        seenScenarioIds.set(scenario.id, index);
      }
    }
  });
export type LiveHostedToolEvaluationScenarioManifest = z.infer<
  typeof LiveHostedToolEvaluationScenarioManifestSchema
>;

export function defaultLiveHostedToolAcceptanceRunId(): string {
  return `live_hosted_tools_${randomUUID()}`;
}

export async function readLiveHostedToolEvaluationScenarioManifest(
  manifestPath: string,
): Promise<LiveHostedToolEvaluationScenarioManifest> {
  const raw = await readFile(manifestPath, "utf-8");
  return LiveHostedToolEvaluationScenarioManifestSchema.parse(parseYaml(raw));
}

export function selectLiveHostedToolEvaluationScenario(
  manifest: LiveHostedToolEvaluationScenarioManifest,
  scenarioId: string,
): LiveHostedToolEvaluationScenario {
  const scenario = manifest.scenarios.find(
    (candidate) => candidate.id === scenarioId,
  );
  if (!scenario) {
    throw new Error(
      `live hosted-tool evaluation scenario ${scenarioId} was not found`,
    );
  }
  return scenario;
}

export function selectActiveLiveHostedToolEvaluationScenario(
  manifest: LiveHostedToolEvaluationScenarioManifest,
  scenarioId: string,
): LiveHostedToolEvaluationScenario {
  const scenario = selectLiveHostedToolEvaluationScenario(manifest, scenarioId);
  if (scenario.execution !== "active") {
    throw new Error(
      `live hosted-tool evaluation scenario ${scenarioId} is ${scenario.execution}, not active`,
    );
  }
  return scenario;
}

export function selectActiveLiveHostedToolEvaluationScenarios(
  manifest: LiveHostedToolEvaluationScenarioManifest,
): LiveHostedToolEvaluationScenario[] {
  return manifest.scenarios.filter(
    (scenario) => scenario.execution === "active",
  );
}

export function shouldRunUnguidedQualysConsumerScenarios(input: {
  explicitRunRequested?: boolean;
  requestedScenarioIds?: string[];
}): boolean {
  return (
    input.explicitRunRequested === true ||
    (input.requestedScenarioIds ?? []).length > 0
  );
}

export function selectUnguidedQualysLiveHostedToolEvaluationScenarios(
  manifest: LiveHostedToolEvaluationScenarioManifest,
  requestedScenarioIds: string[] = [],
): LiveHostedToolEvaluationScenario[] {
  const selected =
    requestedScenarioIds.length > 0
      ? requestedScenarioIds.map((scenarioId) =>
          selectLiveHostedToolEvaluationScenario(manifest, scenarioId),
        )
      : selectActiveLiveHostedToolEvaluationScenarios(manifest).filter(
          (scenario) =>
            scenario.familyId === "qualys" && scenario.guidance === "unguided",
        );
  const invalid = selected.find(
    (scenario) =>
      scenario.familyId !== "qualys" || scenario.guidance !== "unguided",
  );
  if (invalid) {
    throw new Error(
      `live hosted-tool acceptance scenario ${invalid.id} is not an unguided Qualys scenario`,
    );
  }
  return selected;
}

export function resolveLiveHostedToolsDataDir(
  override = process.env["OPENACME_DATA_DIR"],
): string {
  return path.resolve(override ?? DEFAULT_LIVE_HOSTED_TOOLS_DATA_DIR);
}

export function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

export function assertLiveHostedToolsDataDirIsIsolated(dataDir: string): void {
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
  const scenarios = (input.scenarios ?? []).map(deriveScenarioEvidence);
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
  const unredactedArtifact = {
    ...preliminary,
    status:
      secretScan.status === "fail" ? ("fail" as const) : preliminary.status,
    secretScan,
  };
  return redactLiveHostedToolAcceptanceArtifact(
    LiveHostedToolAcceptanceArtifactSchema.parse(unredactedArtifact),
  );
}

export async function writeLiveHostedToolAcceptanceArtifact(
  dataDir: string,
  artifact: LiveHostedToolAcceptanceArtifact,
): Promise<string> {
  const artifactDir = liveHostedToolAcceptanceDir(dataDir);
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, `${artifact.runId}.json`);
  await writeFile(
    artifactPath,
    JSON.stringify(redactLiveHostedToolAcceptanceArtifact(artifact), null, 2) +
      "\n",
  );
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
  const fixedCriticalOutcomes = [
    outcomeConfig(
      "Tool Developer behavior",
      "tool-developer-loads-skill-from-live-message-history",
    ),
    outcomeConfig(
      "Business hosted invocation",
      "qualys-readonly-consumer-live-hosted-tool",
      { includeRuns: true, includeGenerations: true },
    ),
    outcomeConfig(
      "Denied access boundary",
      "qualys-readonly-consumer-live-hosted-tool",
    ),
    outcomeConfig(
      "Failure repair loop",
      "tool-developer-design-preserving-repair-live",
      { includeRuns: true, includeGenerations: true, includeBuckets: true },
    ),
    outcomeConfig(
      "Catalog refresh",
      "live-catalog-refresh-agent-settings-boundary",
      { includeRuns: true, includeGenerations: true, includeNotices: true },
    ),
    outcomeConfig("Live parity matrix", "live-parity-matrix-supporting-evidence", {
      includeParity: true,
    }),
  ];
  const hasAnyFixedCriticalOutcome = fixedCriticalOutcomes.some(({ id }) =>
    Boolean(scenarioById(artifact, id)),
  );
  const lines: string[] = [
    `# Live Hosted-Tool Acceptance: ${artifact.runId}`,
    "",
    `Status: ${artifact.status}`,
    `Completed: ${artifact.completedAt}`,
    `Data dir: ${artifact.dataDir}`,
    ...(artifactPath ? [`Artifact: ${artifactPath}`] : []),
    "",
    "## Critical Outcomes",
    ...(hasAnyFixedCriticalOutcome
      ? fixedCriticalOutcomes.map(({ label, id, options }) =>
          outcomeLine(label, scenarioById(artifact, id), options),
        )
      : []),
    ...unguidedOutcomeLines(artifact),
    `- Secret scan: ${artifact.secretScan.status}${
      artifact.secretScan.findings.length > 0
        ? ` (${artifact.secretScan.findings.length} finding(s))`
        : ""
    }`,
    "",
    "## Evidence Boundary",
    "- Deterministic regression evidence: typecheck, schema tests, analyzer tests, route tests, and hosted-integrations unit tests are run separately in CI/local validation.",
    "- Live external evidence: this artifact captures real LLM/chat behavior and available live vendor parity. It is operator evidence and must not be imported by runtime product code.",
    "- Guidance classification: `prompt_guided` scenarios use explicit operator prompts and are not proof of unguided agent discovery.",
  ];

  const skippedFamilies = liveParitySkippedFamilies(artifact);
  if (skippedFamilies.length > 0) {
    lines.push("", "## Skipped Live Parity Families");
    for (const family of skippedFamilies) {
      lines.push(
        `- ${family.familyId}: ${
          redactSummaryText(family.diagnostics.join("; ")) ||
          "skipped without diagnostic"
        }`,
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

function outcomeConfig(
  label: string,
  id: string,
  options: Parameters<typeof outcomeLine>[2] = {},
): {
  label: string;
  id: string;
  options: Parameters<typeof outcomeLine>[2];
} {
  return { label, id, options };
}

function unguidedOutcomeLines(
  artifact: LiveHostedToolAcceptanceArtifact,
): string[] {
  const scenarios = artifact.scenarios.filter(
    (scenario) => scenario.guidance === "unguided",
  );
  if (scenarios.length === 0) return [];
  const status = scenarios.some((scenario) => scenario.status === "fail")
    ? "fail"
    : scenarios.every((scenario) => scenario.status === "skipped")
      ? "skipped"
      : "pass";
  const runIds = uniqueSummaryStrings(
    scenarios.flatMap((scenario) => scenario.runIds),
  );
  const generationIds = uniqueSummaryStrings(
    scenarios.flatMap((scenario) => scenario.generationIds),
  );
  const evidence = [`${scenarios.length} scenario(s)`];
  if (runIds.length > 0) evidence.push(`runs ${runIds.join(", ")}`);
  if (generationIds.length > 0) {
    evidence.push(`generations ${generationIds.join(", ")}`);
  }
  return [`- Unguided hosted scenarios: ${status} (${evidence.join("; ")})`];
}

function uniqueSummaryStrings(values: Iterable<string>): string[] {
  return [...new Set(values)];
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
            ? `: ${redactSummaryText(scenario.diagnostics.join("; "))}`
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
    diagnostics.push(
      "Tool Developer mutated hosted source before acquiring a lock",
    );
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
  const requiresHostedCall =
    input.expectedOutcome === undefined || input.expectedOutcome === "hosted_call";
  if (input.requireUnguided && scenario.guidance !== "unguided") {
    diagnostics.push("Consumer scenario was not classified as unguided");
  }
  for (const serverName of input.requiredDisabledMcpServers ?? []) {
    if (!(scenario.mcpDisabled ?? []).includes(serverName)) {
      diagnostics.push(
        `Consumer scenario did not record disabled MCP server ${serverName}`,
      );
    }
  }
  const calls = scenario.toolCalls;
  const anyHelpIndex = calls.findIndex(
    (call) => call.toolName === "hosted_tool_help",
  );
  const helpIndex = calls.findIndex(
    (call) => call.toolName === "hosted_tool_help" && call.status !== "error",
  );
  const hostedToolIndex = selectedHostedToolCallIndex(
    calls,
    input.hostedToolName,
  );
  const requiresHostedHelp =
    input.requireHostedHelp !== false &&
    (requiresHostedCall ||
      input.requireDetailedHelpOrVocabularyLookup === true ||
      (input.requiredHelpParameterNames ?? []).length > 0);

  if (requiresHostedHelp && anyHelpIndex < 0) {
    diagnostics.push(
      "Consumer did not call hosted_tool_help before invocation",
    );
  } else if (requiresHostedHelp && helpIndex < 0) {
    diagnostics.push("Consumer did not complete hosted_tool_help successfully");
  }
  if (requiresHostedCall && hostedToolIndex < 0) {
    diagnostics.push(`Consumer did not call ${input.hostedToolName}`);
  }
  if (
    requiresHostedHelp &&
    helpIndex >= 0 &&
    hostedToolIndex >= 0 &&
    helpIndex > hostedToolIndex
  ) {
    diagnostics.push(
      "Consumer called hosted business tool before hosted_tool_help",
    );
  }
  const helpCallsForAnalysis = successfulHelpCallsBeforeHostedCall(
    calls,
    hostedToolIndex,
  );
  if (
    input.requireDetailedHelpOrVocabularyLookup &&
    helpIndex >= 0 &&
    !helpCallsForAnalysis.some(hasDetailedHelpOrVocabularyLookup)
  ) {
    diagnostics.push(
      "Consumer hosted_tool_help call did not request full parameter detail or vocabulary lookup",
    );
  }
  if (helpIndex >= 0) {
    const helpParameterNames = helpCallsForAnalysis.flatMap((call) =>
      helpCallParameterNames(call),
    );
    for (const parameterName of input.requiredHelpParameterNames ?? []) {
      if (
        !helpParameterNames.includes(parameterName) &&
        !helpCallsForAnalysis.some((call) =>
          helpCallSatisfiesNestedParameter(call, parameterName),
        )
      ) {
        diagnostics.push(
          `Consumer hosted_tool_help call did not request required parameter ${parameterName}`,
        );
      }
    }
  }

  const forbiddenToolCall = calls.find(
    (call) =>
      call.toolName.startsWith("mcp_integration-hub__") ||
      call.toolName.startsWith("managed_") ||
      call.toolName === "memory",
  );
  if (forbiddenToolCall) {
    diagnostics.push(
      `Consumer used forbidden non-hosted tool ${forbiddenToolCall.toolName}`,
    );
  }
  const forbiddenHostedToolCall = calls.find((call) =>
    (input.forbiddenHostedToolNames ?? []).includes(call.toolName),
  );
  if (forbiddenHostedToolCall) {
    diagnostics.push(
      `Consumer used forbidden hosted tool ${forbiddenHostedToolCall.toolName}`,
    );
  }

  const hostedCall = hostedToolIndex >= 0 ? calls[hostedToolIndex] : null;
  if (requiresHostedCall && hostedCall?.status === "error") {
    diagnostics.push(
      `Consumer hosted tool call errored: ${input.hostedToolName}`,
    );
  }
  if (requiresHostedCall && hostedCall?.resultSummary?.["ok"] === false) {
    diagnostics.push(
      `Consumer hosted tool returned ok=false: ${input.hostedToolName}`,
    );
  }
  const hasRunEvidence =
    scenario.runIds.length > 0 ||
    calls.some((call) => typeof call.resultSummary?.["runId"] === "string");
  if (requiresHostedCall && !hasRunEvidence) {
    diagnostics.push("Consumer hosted tool evidence did not include a run id");
  }
  const hostedArgs = JSON.stringify(hostedCall?.argsSummary ?? {});
  for (const fragment of input.forbiddenHostedArgumentFragments ?? []) {
    if (hostedArgs.includes(fragment)) {
      diagnostics.push(
        `Consumer hosted tool arguments included forbidden evidence ${fragment}`,
      );
    }
  }
  for (const fragment of input.requiredHostedArgumentFragments ?? []) {
    if (!hostedArgs.includes(fragment)) {
      diagnostics.push(
        `Consumer hosted tool arguments did not include required evidence ${fragment}`,
      );
    }
  }
  const hostedResult = JSON.stringify(hostedCall?.resultSummary ?? {});
  for (const fragment of input.requiredHostedResultFragments ?? []) {
    if (!hostedResult.includes(fragment)) {
      diagnostics.push(
        `Consumer hosted tool result did not include required evidence ${fragment}`,
      );
    }
  }
  for (const key of input.requiredHostedResultSummaryKeys ?? []) {
    if (!hasDottedPath(hostedCall?.resultSummary, key)) {
      diagnostics.push(
        `Consumer hosted tool result did not include required summary key ${key}`,
      );
    }
  }
  const outcomeText = scenario.outcomeText ?? "";
  const normalizedOutcomeText = outcomeText.toLowerCase();
  for (const fragment of input.forbiddenOutcomeFragments ?? []) {
    if (normalizedOutcomeText.includes(fragment.toLowerCase())) {
      diagnostics.push(
        `Consumer outcome included forbidden evidence ${fragment}`,
      );
    }
  }
  for (const fragment of input.requiredOutcomeFragments ?? []) {
    if (!normalizedOutcomeText.includes(fragment.toLowerCase())) {
      diagnostics.push(
        `Consumer outcome did not include required evidence ${fragment}`,
      );
    }
  }
  if (input.expectedOutcome === "evidence_required") {
    if (!/EVIDENCE_REQUIRED/i.test(outcomeText)) {
      diagnostics.push("Consumer outcome did not report EVIDENCE_REQUIRED");
    }
  } else if (input.expectedOutcome === "refusal") {
    if (
      !/\b(refuse|refused|cannot|can't|not available|outside|not allowed)\b/i.test(
        outcomeText,
      )
    ) {
      diagnostics.push("Consumer outcome did not refuse the request");
    }
  } else if (input.expectedOutcome === "recovery") {
    if (
      !/\b(retry|re-run|rerun|recover|correct|fix|check|configure|permission|rate[- ]?limit|authentication|auth)\b/i.test(
        outcomeText,
      )
    ) {
      diagnostics.push("Consumer outcome did not include recovery guidance");
    }
  } else if (input.expectedOutcome === "hosted_call") {
    if (hostedToolIndex < 0) {
      diagnostics.push(
        `Consumer expected hosted call outcome but did not call ${input.hostedToolName}`,
      );
    }
  }

  return {
    status: diagnostics.length === 0 ? "pass" : "fail",
    diagnostics,
  };
}

export function summarizeDirectHostedInvokeResult(
  body: unknown,
): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  const summary: Record<string, unknown> = {};
  if (typeof body["ok"] === "boolean") summary["ok"] = body["ok"];
  if (typeof body["runId"] === "string") summary["runId"] = body["runId"];
  if (typeof body["generationId"] === "string") {
    summary["generationId"] = body["generationId"];
  }
  if (isRecord(body["error"])) {
    summary["error"] = body["error"];
  }
  const envelope = body["envelope"];
  if (isRecord(envelope)) {
    if (isRecord(envelope["result_ref"])) {
      summary["responseMode"] = "artifact";
      summary["resultPathInspected"] = true;
      summary["artifact"] = artifactRefSummary(envelope["result_ref"]);
    } else if ("result" in envelope) {
      summary["responseMode"] = "inline";
      summary["resultPathInspected"] = true;
      summary["result"] = directInvokeInlineResultSummary(envelope["result"]);
      if (isRecord(envelope["result"])) {
        const result = envelope["result"];
        if (isRecord(result["pagination"])) {
          summary["pagination"] = objectSummary(result["pagination"]);
        }
      }
    }
  }
  return Object.keys(summary).length > 0 ? summary : null;
}

export function lintUnguidedConsumerPrompt(
  prompt: string,
): UnguidedConsumerPromptLintResult {
  const findings: UnguidedConsumerPromptLintFinding[] = [];
  const checks: Array<{ rule: string; pattern: RegExp }> = [
    { rule: "explicit-hosted-tool-name", pattern: /hosted_[a-z0-9-]+__/i },
    { rule: "explicit-help-tool-name", pattern: /\bhosted_tool_help\b/i },
    { rule: "explicit-managed-tool-name", pattern: /\bmanaged_[a-z0-9-]+__/i },
    { rule: "explicit-remote-mcp-tool-name", pattern: /\bmcp_[a-z0-9_-]+__/i },
    {
      rule: "explicit-help-instruction",
      pattern: /\b(call|use|invoke|run)\s+hosted_tool_help\b/i,
    },
    {
      rule: "exact-argument-json",
      pattern: /"filter_body"\s*:|"filters"\s*:|"field"\s*:/i,
    },
  ];
  for (const check of checks) {
    const match = prompt.match(check.pattern);
    if (match?.[0]) {
      findings.push({ rule: check.rule, excerpt: match[0].slice(0, 120) });
    }
  }
  return { status: findings.length === 0 ? "pass" : "fail", findings };
}

function hasDetailedHelpOrVocabularyLookup(
  helpCall: LiveHostedToolCallEvidence,
): boolean {
  const args = helpCall.argsSummary ?? {};
  if (args["tool_detail"] === "full") return true;
  const serialized = JSON.stringify(args);
  return (
    serialized.includes('"detail":"full"') ||
    serialized.includes('"query"') ||
    serialized.includes('"value"')
  );
}

function successfulHelpCallsBeforeHostedCall(
  calls: LiveHostedToolCallEvidence[],
  hostedToolIndex: number,
): LiveHostedToolCallEvidence[] {
  const upperBound = hostedToolIndex >= 0 ? hostedToolIndex : calls.length;
  return calls
    .slice(0, upperBound)
    .filter(
      (call) => call.toolName === "hosted_tool_help" && call.status !== "error",
    );
}

function selectedHostedToolCallIndex(
  calls: readonly LiveHostedToolCallEvidence[],
  hostedToolName: string,
): number {
  const matchingIndexes = calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => call.toolName === hostedToolName);
  const successful = matchingIndexes.find(
    ({ call }) => call.resultSummary?.["ok"] === true,
  );
  if (successful) return successful.index;
  const output = matchingIndexes.find(
    ({ call }) => call.status === "output" && call.resultSummary?.["ok"] !== false,
  );
  if (output) return output.index;
  return matchingIndexes[0]?.index ?? -1;
}

function helpCallParameterNames(
  helpCall: LiveHostedToolCallEvidence,
): string[] {
  const parameters = helpCall.argsSummary?.["parameters"];
  if (!Array.isArray(parameters)) return [];
  return parameters
    .map((parameter) => {
      if (!isRecord(parameter)) return null;
      const name = parameter["name"];
      return typeof name === "string" ? name : null;
    })
    .filter((name): name is string => typeof name === "string");
}

function helpCallSatisfiesNestedParameter(
  helpCall: LiveHostedToolCallEvidence,
  requiredParameterName: string,
): boolean {
  const parameters = helpCall.argsSummary?.["parameters"];
  if (!Array.isArray(parameters)) return false;
  return parameters.some((parameter) => {
    if (!isRecord(parameter)) return false;
    const name = parameter["name"];
    if (typeof name !== "string") return false;
    if (!requiredParameterName.startsWith(`${name}.`)) return false;
    return Boolean(parameter["query"] || parameter["value"]);
  });
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
    if (ungrantedCalls.some((call) => call.toolName === input.hostedToolName)) {
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
    diagnostics.push(
      "Catalog notice leaked into canonical chat message context",
    );
  }
  if (input.remoteMcpBoundaryOk === false) {
    diagnostics.push(
      "Remote MCP selection incorrectly enabled hosted tool access",
    );
  }
  if (scenario.catalogNoticeIds.length === 0) {
    diagnostics.push(
      "Catalog refresh scenario evidence did not include notice ids",
    );
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
    if (
      result.artifactPath &&
      !scenario.artifactPaths.includes(result.artifactPath)
    ) {
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
    diagnostics.push(
      `Live parity reported unexpected family ${result.familyId}`,
    );
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
    diagnostics.push(
      "Tool Developer mutated hosted source before acquiring a lock",
    );
  }

  const runGetIndex = firstIndexOfTool(calls, "hosted_tool_run_get");
  const bucketIndex = firstIndexWhere(calls, (call) =>
    [
      "hosted_tool_failure_bucket_get",
      "hosted_tool_failure_bucket_list",
    ].includes(call.toolName),
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
      diagnostics.push(
        "Tool Developer patched before inspecting the failing run",
      );
    }
    if (bucketIndex < 0 || bucketIndex > firstMutation) {
      diagnostics.push(
        "Tool Developer patched before inspecting the failure bucket",
      );
    }
    if (sourceViewIndex < 0 || sourceViewIndex > firstMutation) {
      diagnostics.push(
        "Tool Developer patched before inspecting focused source",
      );
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
    diagnostics.push(
      "Tool Developer did not debug-run the repaired generation",
    );
  } else {
    const debugRun = calls[debugRunIndex];
    if (debugRun?.resultSummary?.["ok"] === false) {
      diagnostics.push(
        "Tool Developer debug-run of repaired generation failed",
      );
    }
    if (promoteIndex >= 0 && debugRunIndex < promoteIndex) {
      diagnostics.push("Tool Developer debug-ran before promoting the repair");
    }
  }

  const closeIndex = firstIndexOfTool(
    calls,
    "hosted_tool_failure_bucket_close",
  );
  if (closeIndex < 0) {
    diagnostics.push("Tool Developer did not close the failure bucket");
  } else {
    const closeCall = calls[closeIndex];
    if (debugRunIndex >= 0 && closeIndex < debugRunIndex) {
      diagnostics.push("Tool Developer closed the bucket before debug proof");
    }
    if (
      input.bucketId &&
      closeCall?.argsSummary?.["bucket_id"] !== input.bucketId
    ) {
      diagnostics.push("Tool Developer closed a different failure bucket");
    }
    if (typeof closeCall?.argsSummary?.["generation_id"] !== "string") {
      diagnostics.push(
        "Tool Developer closed bucket without generation evidence",
      );
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
    diagnostics.push(
      "Repair scenario evidence did not include a failure bucket id",
    );
  }
  if (scenario.runIds.length === 0) {
    diagnostics.push(
      "Repair scenario evidence did not include hosted run evidence",
    );
  }
  if (scenario.generationIds.length === 0) {
    diagnostics.push(
      "Repair scenario evidence did not include repaired generation id",
    );
  }

  const familyId = input.familyId;
  if (
    familyId &&
    !calls.some((call) =>
      JSON.stringify(call.argsSummary ?? {}).includes(familyId),
    )
  ) {
    diagnostics.push(`Repair transcript did not reference family ${familyId}`);
  }
  const toolName = input.toolName;
  if (
    toolName &&
    !calls.some((call) =>
      JSON.stringify(call.argsSummary ?? {}).includes(toolName),
    )
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

export function extractLiveHostedToolMessageHistoryEvidence(
  input: MessageHistoryToolEvidenceInput & {
    maxMessages?: number;
    maxTextChars?: number;
  },
): LiveHostedToolMessageEvidence[] {
  const maxMessages = input.maxMessages ?? 40;
  const maxTextChars = input.maxTextChars ?? 1_000;
  return input.messages.slice(-maxMessages).map((message) => ({
    ...(message.id ? { id: message.id } : {}),
    role: message.role,
    parts: message.parts.map((part) =>
      messagePartEvidence(part, { maxTextChars }),
    ),
  }));
}

export function extractLiveHostedToolOutcomeTextFromMessageHistory(
  input: MessageHistoryOutcomeTextInput,
): string | undefined {
  const maxChars = input.maxChars ?? 1_000;
  for (const message of [...input.messages].reverse()) {
    if (message.role !== "assistant") continue;
    const text = message.parts
      .map((part) => (typeof part["text"] === "string" ? part["text"] : ""))
      .join("\n")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 0) return text.slice(0, maxChars);
  }
  return undefined;
}

function messagePartEvidence(
  part: Record<string, unknown>,
  options: { maxTextChars: number },
): LiveHostedToolMessagePartEvidence {
  const type =
    typeof part["type"] === "string" && part["type"].length > 0
      ? part["type"]
      : "unknown";
  const evidence: LiveHostedToolMessagePartEvidence = { type };
  if (typeof part["text"] === "string" && part["text"].trim().length > 0) {
    evidence.text = redactSummaryText(
      part["text"].replace(/\s+/g, " ").trim(),
    ).slice(0, options.maxTextChars);
  }
  if (type.startsWith("tool-")) {
    evidence.toolName = type.slice("tool-".length);
    if (typeof part["state"] === "string") evidence.state = part["state"];
    const inputSummary = toolPartInputSummary(part);
    const outputSummary = toolPartOutputSummary(part);
    if (inputSummary) {
      evidence.inputSummary = redactValue(inputSummary) as Record<
        string,
        unknown
      >;
    }
    if (outputSummary) {
      evidence.outputSummary = redactValue(outputSummary) as Record<
        string,
        unknown
      >;
    }
  } else if (type.startsWith("data-") && isRecord(part["data"])) {
    const dataSummary = objectSummary(part["data"]);
    if (dataSummary) {
      evidence.dataSummary = redactValue(dataSummary) as Record<string, unknown>;
    }
  }
  return evidence;
}

export function extractUpstreamErrorDiagnosticsFromMessageHistory(
  input: MessageHistoryUpstreamErrorDiagnosticsInput,
): string[] {
  const maxChars = input.maxChars ?? 500;
  const diagnostics: string[] = [];
  for (const message of input.messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part["type"] !== "data-upstream-error") continue;
      const data = isRecord(part["data"]) ? part["data"] : {};
      const provider =
        typeof data["provider"] === "string" && data["provider"].length > 0
          ? data["provider"]
          : "unknown";
      const statusCode =
        typeof data["statusCode"] === "number" ||
        typeof data["statusCode"] === "string"
          ? String(data["statusCode"])
          : "unknown";
      const messageText =
        typeof data["message"] === "string" && data["message"].length > 0
          ? data["message"]
          : "upstream provider error";
      diagnostics.push(
        redactSummaryText(
          `Upstream provider error from ${provider} status ${statusCode}: ${messageText}`,
        ).slice(0, maxChars),
      );
    }
  }
  return diagnostics;
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
  if (scenario.guidance) {
    evidence.push(`guidance ${scenario.guidance}`);
  }
  if (scenario.expectedOutcome) {
    evidence.push(`expected ${scenario.expectedOutcome}`);
  }
  if ((scenario.availableToolNames ?? []).length > 0) {
    evidence.push(`candidates ${(scenario.availableToolNames ?? []).join(", ")}`);
  }
  const helpParameterNames =
    scenario.preInvocationHelpParameterNames ??
    preInvocationHelpParameterNames(scenario);
  if (helpParameterNames.length > 0) {
    evidence.push(
      `help parameters ${helpParameterNames.map(redactSummaryText).join(", ")}`,
    );
  }
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
  if (scenario.outcomeText) {
    evidence.push(
      `outcome ${compactOutcomeText(redactSummaryText(scenario.outcomeText))}`,
    );
  }
  return `- ${label}: ${scenario.status}${
    evidence.length > 0 ? ` (${evidence.join("; ")})` : ""
  }`;
}

function deriveScenarioEvidence(
  scenario: LiveHostedToolScenarioEvidence,
): LiveHostedToolScenarioEvidence {
  return {
    ...scenario,
    preInvocationHelpParameterNames:
      scenario.preInvocationHelpParameterNames ??
      preInvocationHelpParameterNames(scenario),
  };
}

function preInvocationHelpParameterNames(
  scenario: LiveHostedToolScenarioEvidence,
): string[] {
  const names = new Set<string>();
  const calls = scenario.toolCalls;
  const hostedToolIndex = calls.findIndex((call) =>
    isHostedBusinessToolName(call.toolName),
  );
  for (const call of successfulHelpCallsBeforeHostedCall(calls, hostedToolIndex)) {
    for (const name of helpCallParameterNames(call)) {
      names.add(name);
    }
  }
  return [...names];
}

function isHostedBusinessToolName(toolName: string): boolean {
  return toolName.startsWith("hosted_") && !toolName.startsWith("hosted_tool_");
}

function compactOutcomeText(outcomeText: string): string {
  const compact = outcomeText.replace(/\s+/g, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function redactSummaryText(value: string): string {
  return redactSecretString(value);
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

function hasDottedPath(value: unknown, dottedPath: string): boolean {
  let current = value;
  for (const segment of dottedPath.split(".")) {
    if (!current || typeof current !== "object") return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return current !== undefined;
}

function artifactRefSummary(ref: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof ref["name"] === "string" ? { name: ref["name"] } : {}),
    ...(typeof ref["size_bytes"] === "number"
      ? { sizeBytes: ref["size_bytes"] }
      : {}),
    ...(typeof ref["estimated_tokens"] === "number"
      ? { estimatedTokens: ref["estimated_tokens"] }
      : {}),
  };
}

function directInvokeInlineResultSummary(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const summary: Record<string, unknown> = {};
  for (const key of [
    "count",
    "total",
    "total_count",
    "returned",
    "truncated",
    "continuation",
    "pagination",
    "next_cursor",
    "next_page",
    "next_last_seen_asset_id",
    "pages_fetched",
  ]) {
    if (value[key] !== undefined) summary[key] = value[key];
  }
  return Object.keys(summary).length > 0 ? summary : "[object]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
      const parsed = JSON.parse(raw);
      return hostedEnvelopeSummary(parsed) ?? objectSummary(parsed);
    } catch {
      return { text: raw.slice(0, 240) };
    }
  }
  return hostedEnvelopeSummary(raw) ?? objectSummary(raw);
}

function hostedEnvelopeSummary(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !isRecord(value["envelope"])) return null;
  return summarizeDirectHostedInvokeResult(value);
}

function objectSummary(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item && typeof item === "object") {
      out[key] =
        Array.isArray(item) && key === "parameters"
          ? item.slice(0, 5).map((entry) => parameterRequestSummary(entry))
          : Array.isArray(item)
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
  if (key === "parameters" && Array.isArray(value)) {
    return value.slice(0, 5).map((item) => parameterRequestSummary(item));
  }
  if (key === "filter_body" || key === "search_body") {
    return filterBodySummary(value);
  }
  if (key === "params") {
    return nativeParamsSummary(value);
  }
  if (!["error", "readiness", "policy", "diagnostics"].includes(key)) {
    return "[object]";
  }
  return objectSummary(value) ?? "[object]";
}

function parameterRequestSummary(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "[value]";
  }
  const raw = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of [
    "name",
    "detail",
    "include_examples",
    "query",
    "value",
    "limit",
  ]) {
    if (raw[key] !== undefined) summary[key] = raw[key];
  }
  return summary;
}

function filterBodySummary(value: object): unknown {
  const raw = value as Record<string, unknown>;
  const filters = Array.isArray(raw["filters"])
    ? raw["filters"].slice(0, 5).map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return "[value]";
        }
        const filter = item as Record<string, unknown>;
        return {
          ...(typeof filter["field"] === "string"
            ? { field: filter["field"] }
            : {}),
          ...(typeof filter["operator"] === "string"
            ? { operator: filter["operator"] }
            : {}),
          ...(filter["value"] !== undefined
            ? { value: redactValue(filter["value"]) }
            : {}),
        };
      })
    : [];
  return {
    ...(typeof raw["operation"] === "string"
      ? { operation: raw["operation"] }
      : {}),
    filters,
  };
}

function nativeParamsSummary(value: object): unknown {
  const raw = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
      summary[key] = redactValue(item);
    }
  }
  return Object.keys(summary).length > 0 ? summary : "[object]";
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

function redactLiveHostedToolAcceptanceArtifact(
  artifact: LiveHostedToolAcceptanceArtifact,
): LiveHostedToolAcceptanceArtifact {
  return LiveHostedToolAcceptanceArtifactSchema.parse(redactValue(artifact));
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecretString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (isSecretKey(key) && typeof item === "string" && !isRedacted(item)) {
          return [key, "[redacted]"];
        }
        return [key, redactValue(item)];
      }),
    );
  }
  return value;
}

function scanString(
  value: string,
  currentPath: string,
  findings: LiveHostedToolSecretScanFinding[],
): void {
  for (const rule of LIVE_ACCEPTANCE_SECRET_STRING_RULES) {
    const match = value.match(rule.pattern);
    if (!match) continue;
    findings.push({
      path: currentPath,
      rule: rule.name,
      excerpt: redactExcerpt(match[0] ?? value),
    });
  }
}

function redactSecretString(value: string): string {
  return LIVE_ACCEPTANCE_SECRET_STRING_RULES.reduce(
    (redacted, rule) => redacted.replace(rule.pattern, "[redacted]"),
    value,
  );
}

const LIVE_ACCEPTANCE_SECRET_STRING_RULES: Array<{
  name: string;
  pattern: RegExp;
}> = [
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  {
    name: "access-token-assignment",
    pattern: /\baccess_token\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
  },
  {
    name: "jwt-token",
    pattern: /\beyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{20,}){0,2}\b/g,
  },
  {
    name: "openai-style-secret",
    pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    name: "secret-assignment",
    pattern:
      /\b(?:client_secret|password|token|api[_-]?key)\b\s*[:=]\s*["']?[^"',\s]{8,}/gi,
  },
  {
    name: "vendor-secret-assignment",
    pattern:
      /\b(?:QUALYS_PASSWORD|QUALYS_USERNAME|SPLUNK_TOKEN|MSGRAPH_CLIENT_SECRET|MDE_CLIENT_SECRET|DEFENDER_CLIENT_SECRET)\b\s*[:=]\s*["']?[^"',\s]{8,}/g,
  },
  { name: "raw-secret-sentinel", pattern: /\braw-secret\b/gi },
];

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
