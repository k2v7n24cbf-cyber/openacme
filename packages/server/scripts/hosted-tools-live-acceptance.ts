import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { serve, type ServerType } from "@hono/node-server";
import { loadConfig } from "@openacme/config";
import {
  buildHostedToolName,
  type HostedIntegrationService,
} from "@openacme/hosted-integrations";
import { createApp } from "../src/app.js";
import {
  defaultLiveParityCasesForFamily,
  runHostedIntegrationLiveParity,
} from "../test-support/integration-hub/live-parity.js";
import {
  analyzeCatalogRefreshEvidence,
  analyzeConsumerHostedToolEvidence,
  analyzeLiveParityMatrixEvidence,
  analyzeToolDeveloperBehaviorEvidence,
  analyzeToolDeveloperRepairBehaviorEvidence,
  assertLiveHostedToolsDataDirIsIsolated,
  buildLiveHostedToolAcceptanceArtifact,
  extractLiveHostedToolCallsFromMessageHistory,
  resolveLiveHostedToolsDataDir,
  scanLiveHostedToolAcceptanceSecrets,
  writeLiveHostedToolAcceptanceArtifact,
  writeLiveHostedToolAcceptanceReport,
  type CatalogRefreshNoticeEvidence,
  type LiveHostedToolScenarioEvidence,
} from "../test-support/hosted-tools/live-acceptance.js";

const dataDir = resolveLiveHostedToolsDataDir();
const legacyMcpDataDir =
  process.env["OPENACME_LEGACY_MCP_DATA_DIR"] ?? dataDir;
const requestedPort = positivePort(process.env["OPENACME_E2E_PORT"]) ?? 3466;
const chatDeadlineMs =
  positiveInteger(process.env["OPENACME_LIVE_HOSTED_TOOLS_CHAT_TIMEOUT_MS"]) ??
  120_000;
const settleBeforeCloseMs =
  positiveInteger(process.env["OPENACME_LIVE_HOSTED_TOOLS_SETTLE_MS"]) ?? 5_000;
const liveQualysConsumerAgentId = "live-qualys-analyst";
const liveQualysDeniedAgentId = "live-qualys-denied";
const liveRepairConsumerAgentId = "live-repair-consumer";
const liveCatalogGrantedAgentId = "live-catalog-granted";
const liveCatalogUngrantedAgentId = "live-catalog-ungranted";
const liveParityFamilyIds = [
  "qualys",
  "splunk",
  "msgraph",
  "mde",
  "defender-alert",
] as const;

let server: ServerType | null = null;
let authToken = "";

interface HostedToolRouteTool {
  name?: unknown;
  classification?: { operation?: unknown };
}

interface LiveFailureBucketRef {
  id: string;
  familyId: string;
  toolName: string;
  generationId: string;
}

type ScenarioEvidenceBase = Omit<
  LiveHostedToolScenarioEvidence,
  "status" | "diagnostics" | "messageIds" | "toolCalls"
>;

async function main(): Promise<void> {
  const startedAt = new Date();
  assertLiveHostedToolsDataDirIsIsolated(dataDir);
  process.env["OPENACME_DATA_DIR"] = dataDir;
  const config = loadConfig(dataDir);
  if (!config.model.provider || !config.model.model) {
    throw new Error(
      "live hosted-tool acceptance requires a configured real LLM provider and model",
    );
  }

  const { app, manager, runtime, close } = await createApp(config);
  try {
    await manager.ensureManagedAgents();
    const member =
      manager.authStore.getMemberByEmail("live-hosted-tools@example.com") ??
      manager.authStore.createMember({
        email: "live-hosted-tools@example.com",
        password: `live-hosted-tools-${randomUUID()}`,
      });
    authToken = manager.authStore.createSession(member.id).token;
    const started = await new Promise<{ server: ServerType; port: number }>(
      (resolve) => {
        const s = serve(
          { fetch: app.fetch, port: requestedPort, hostname: "127.0.0.1" },
          (info) => resolve({ server: s, port: info.port }),
        );
      },
    );
    server = started.server;
    const baseUrl = `http://127.0.0.1:${started.port}`;
    const scenarios = [
      await healthScenario(baseUrl),
      await toolDeveloperLoadsSkillScenario(baseUrl),
      await liveParityMatrixScenario(runtime.hostedIntegrationService),
      await qualysReadOnlyVendorScenario(baseUrl, config.model),
      await designPreservingRepairScenario(baseUrl, config.model),
      await catalogRefreshBoundaryScenario(baseUrl, config.model),
    ];
    const artifact = buildLiveHostedToolAcceptanceArtifact({
      runId: process.env["OPENACME_LIVE_HOSTED_TOOLS_RUN_ID"] ?? undefined,
      startedAt,
      completedAt: new Date(),
      dataDir,
      baseUrl,
      model: config.model,
      scenarios,
      diagnostics: [
        "Milestone 27 live runner harvests real /api/chat message history for Tool Developer, consumer hosted-tool behavior, repair behavior, catalog-refresh/session-boundary behavior, and live parity matrix evidence.",
      ],
    });
    const artifactPath = await writeLiveHostedToolAcceptanceArtifact(
      dataDir,
      artifact,
    );
    const reportPaths = await writeLiveHostedToolAcceptanceReport(
      dataDir,
      artifact,
      artifactPath,
    );
    console.log(JSON.stringify({ ...artifact, artifactPath, ...reportPaths }, null, 2));
    process.exitCode = artifact.status === "fail" ? 1 : 0;
  } finally {
    await sleep(settleBeforeCloseMs);
    await withTimeout(closeServer(), 5_000, "HTTP server close");
    await withTimeout(close(), 5_000, "app runtime close");
  }
}

async function healthScenario(
  baseUrl: string,
): Promise<LiveHostedToolScenarioEvidence> {
  const res = await fetch(`${baseUrl}/api/health`, {
    headers: { host: "127.0.0.1" },
  });
  const body = await res.text();
  return {
    id: "runner-starts-isolated-server",
    guidance: "operator_instrumented",
    status: res.ok ? "pass" : "fail",
    diagnostics: res.ok
      ? []
      : [`/api/health returned HTTP ${res.status}: ${body.slice(0, 300)}`],
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
  };
}

async function qualysReadOnlyVendorScenario(
  baseUrl: string,
  model: { provider?: string; model?: string },
): Promise<LiveHostedToolScenarioEvidence> {
  const familyId = "qualys";
  const preferredToolName = "qualys_gav_asset_count";
  const scenarioBase: ScenarioEvidenceBase = {
    id: "qualys-readonly-consumer-live-hosted-tool",
    guidance: "prompt_guided",
    prompts: [] as string[],
    agentIds: [liveQualysConsumerAgentId, liveQualysDeniedAgentId],
    sessionIds: [] as string[],
    generationIds: [] as string[],
    runIds: [] as string[],
    failureBucketIds: [] as string[],
    catalogNoticeIds: [] as string[],
    artifactPaths: [] as string[],
  };

  try {
    const toolsRes = await req(
      baseUrl,
      `/api/hosted-integrations/families/${familyId}/tools`,
    );
    if (toolsRes.status === 404) {
      return skippedScenario(scenarioBase, ["Qualys hosted family is not present"]);
    }
    if (!toolsRes.ok) {
      return failedScenario(scenarioBase, [
        `Qualys tools lookup failed HTTP ${toolsRes.status}: ${await safeResponseText(toolsRes)}`,
      ]);
    }
    const toolsBody = (await toolsRes.json()) as {
      tools?: HostedToolRouteTool[];
    };
    const tools: HostedToolRouteTool[] = Array.isArray(toolsBody?.tools)
      ? toolsBody.tools
      : [];
    const tool =
      tools.find((candidate) => candidate.name === preferredToolName) ??
      tools.find(
        (candidate) => candidate.classification?.operation === "read",
      );
    if (!tool || typeof tool.name !== "string") {
      return skippedScenario(scenarioBase, [
        "Qualys hosted family has no active read-only tool",
      ]);
    }
    const toolName = tool.name;
    const hostedToolName = buildHostedToolName({ familyId, toolName });
    const runtimeConfigGeneration = await ensureLatestGenerationRuntimeConfig(
      baseUrl,
      familyId,
    );
    scenarioBase.generationIds.push(...runtimeConfigGeneration.generationIds);
    const binding = agentHostedBinding(familyId, toolName);
    await upsertLiveAgent(baseUrl, {
      id: liveQualysConsumerAgentId,
      name: "Live Qualys Analyst",
      role: "Consumes read-only hosted Qualys tools during live acceptance.",
      model,
      persona:
        "Use hosted_tool_help before unfamiliar hosted tools. Prefer read-only hosted tools when asked.",
      tools: ["hosted_tool_help", hostedToolName],
      hostedIntegrationBindings: [binding],
    });
    await upsertLiveAgent(baseUrl, {
      id: liveQualysDeniedAgentId,
      name: "Live Qualys Denied",
      role: "Negative hosted-tool access-policy acceptance agent.",
      model,
      persona: "This agent intentionally has no hosted Qualys binding.",
      tools: [],
      hostedIntegrationBindings: [],
    });

    const readinessRes = await req(
      baseUrl,
      `/api/hosted-integrations/readiness/invocation?agentId=${encodeURIComponent(
        liveQualysConsumerAgentId,
      )}&familyId=${encodeURIComponent(familyId)}&toolName=${encodeURIComponent(
        toolName,
      )}`,
    );
    if (!readinessRes.ok) {
      return skippedScenario(scenarioBase, [
        `Qualys invocation readiness check failed HTTP ${readinessRes.status}: ${await safeResponseText(readinessRes)}`,
      ]);
    }
    const readiness = (await readinessRes.json()) as {
      ok?: unknown;
      readiness?: { status?: unknown };
    };
    if (readiness?.ok !== true || readiness?.readiness?.status === "blocked") {
      return skippedScenario(scenarioBase, [
        `Qualys invocation readiness is not ready: ${summarizeJson(readiness)}`,
      ]);
    }

    const scenarioStartedAt = new Date();
    const sessionId = randomUUID();
    const prompt = [
      "Use the read-only hosted Qualys asset count tool.",
      `First call hosted_tool_help for ${hostedToolName} with full tool detail, examples, and full filter_body parameter detail.`,
      `Then call ${hostedToolName} exactly once with this safe filter body:`,
      jsonBlock(safeQualysCountArgs()),
      "Do not call remote MCP or managed_* tools. After the hosted tool result, answer in one concise sentence.",
    ].join("\n");
    scenarioBase.prompts.push(prompt);
    scenarioBase.sessionIds.push(sessionId);

    const chatRes = await postJson(baseUrl, "/api/chat", {
      agentId: liveQualysConsumerAgentId,
      sessionId,
      messages: [
        {
          id: randomUUID(),
          role: "user",
          parts: [{ type: "text", text: prompt }],
        },
      ],
    });
    if (chatRes.status !== 200) {
      return failedScenario(scenarioBase, [
        `/api/chat returned HTTP ${chatRes.status}: ${await safeResponseText(chatRes)}`,
      ]);
    }

    const messages = await waitForSessionMessagesWithTool(
      baseUrl,
      sessionId,
      hostedToolName,
    );
    const toolCalls = extractLiveHostedToolCallsFromMessageHistory({
      agentId: liveQualysConsumerAgentId,
      sessionId,
      messages,
    });
    const messageIds = messages
      .map((message) => message.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const diagnostics: string[] = [];
    const blockingDiagnostics: string[] = [];
    diagnostics.push(...runtimeConfigGeneration.diagnostics);
    const runLookup = await runIdsFromExecutionLogs(baseUrl, {
      actorId: liveQualysConsumerAgentId,
      familyId,
      toolName,
      after: scenarioStartedAt,
    });
    diagnostics.push(...runLookup.diagnostics);
    let runIds = uniqueStrings([
      ...runIdsFromToolCalls(toolCalls),
      ...runLookup.runIds,
    ]);
    let generationIds = uniqueStrings([
      ...generationIdsFromToolCalls(toolCalls),
      ...(await generationIdsFromRuns(baseUrl, runIds, {
        actorId: liveQualysConsumerAgentId,
        familyId,
        toolName,
      })),
    ]);
    const hostedToolReturnedFailure = toolCalls.some(
      (call) =>
        call.toolName === hostedToolName && call.resultSummary?.["ok"] === false,
    );
    if (hostedToolReturnedFailure || runIds.length === 0) {
      const directInvoke = await directHostedInvokeDiagnostic(baseUrl, {
        actorId: liveQualysConsumerAgentId,
        familyId,
        toolName,
        args: safeQualysCountArgs(),
      });
      diagnostics.push(...directInvoke.diagnostics);
      runIds = uniqueStrings([...runIds, ...directInvoke.runIds]);
      generationIds = uniqueStrings([
        ...generationIds,
        ...directInvoke.generationIds,
        ...(await generationIdsFromRuns(baseUrl, directInvoke.runIds, {
          actorId: liveQualysConsumerAgentId,
          familyId,
          toolName,
        })),
      ]);
    }
    const denied = await postJson(baseUrl, "/api/hosted-integrations/invoke", {
      actor: { id: liveQualysDeniedAgentId, kind: "agent", roles: ["agent"] },
      familyId,
      toolName,
      args: {},
      hostedToolBindings: [],
      requestedEnvironment: "test_debug",
    });
    const deniedBody = await safeJson(denied);
    const deniedError = isRecord(deniedBody?.["error"])
      ? deniedBody["error"]
      : null;
    if (denied.status !== 403 || deniedError?.["code"] !== "binding_missing") {
      const diagnostic = `Denied agent did not receive binding_missing: HTTP ${denied.status} ${summarizeJson(deniedBody)}`;
      diagnostics.push(diagnostic);
      blockingDiagnostics.push(diagnostic);
    }
    const scenario: LiveHostedToolScenarioEvidence = {
      ...scenarioBase,
      status: "pass",
      diagnostics,
      messageIds,
      toolCalls,
      runIds,
      generationIds,
    };
    const analysis = analyzeConsumerHostedToolEvidence(scenario, {
      hostedToolName,
    });
    return {
      ...scenario,
      status:
        blockingDiagnostics.length === 0 && analysis.status === "pass"
          ? "pass"
          : "fail",
      diagnostics: [...diagnostics, ...analysis.diagnostics],
    };
  } catch (error) {
    return failedScenario(scenarioBase, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
}

async function designPreservingRepairScenario(
  baseUrl: string,
  model: { provider?: string; model?: string },
): Promise<LiveHostedToolScenarioEvidence> {
  const suffix = Date.now().toString(36);
  const familyId = `repair-live-${suffix}`;
  const toolName = "repair_echo";
  const hostedToolName = buildHostedToolName({ familyId, toolName });
  const regressionExampleId = "regression_boom_request";
  const scenarioBase: ScenarioEvidenceBase = {
    id: "tool-developer-design-preserving-repair-live",
    guidance: "prompt_guided",
    prompts: [] as string[],
    agentIds: [liveRepairConsumerAgentId, "tool-developer"],
    sessionIds: [] as string[],
    generationIds: [] as string[],
    runIds: [] as string[],
    failureBucketIds: [] as string[],
    catalogNoticeIds: [] as string[],
    artifactPaths: [] as string[],
  };

  try {
    const setup = await createBuggyRepairFamily(baseUrl, {
      familyId,
      toolName,
      regressionExampleId,
    });
    scenarioBase.generationIds.push(setup.generationId);
    await upsertLiveAgent(baseUrl, {
      id: liveRepairConsumerAgentId,
      name: "Live Repair Consumer",
      role: "Triggers a safe hosted-tool code failure during live acceptance.",
      model,
      persona:
        "Use the requested hosted tool directly and report only whether it succeeded.",
      tools: [hostedToolName],
      hostedIntegrationBindings: [agentHostedBinding(familyId, toolName)],
    });

    const consumerSessionId = randomUUID();
    const consumerPrompt = [
      `Call ${hostedToolName} exactly once with {"text":"boom"}.`,
      "Do not call any remote MCP or managed_* tools.",
      "After the tool result, answer in one concise sentence.",
    ].join("\n");
    scenarioBase.prompts.push(consumerPrompt);
    scenarioBase.sessionIds.push(consumerSessionId);
    const consumerChat = await postJson(baseUrl, "/api/chat", {
      agentId: liveRepairConsumerAgentId,
      sessionId: consumerSessionId,
      messages: [
        {
          id: randomUUID(),
          role: "user",
          parts: [{ type: "text", text: consumerPrompt }],
        },
      ],
    });
    if (consumerChat.status !== 200) {
      return failedScenario(scenarioBase, [
        `consumer failure chat returned HTTP ${consumerChat.status}: ${await safeResponseText(consumerChat)}`,
      ]);
    }
    const consumerMessages = await waitForSessionMessagesWithTool(
      baseUrl,
      consumerSessionId,
      hostedToolName,
    );
    const consumerCalls = extractLiveHostedToolCallsFromMessageHistory({
      agentId: liveRepairConsumerAgentId,
      sessionId: consumerSessionId,
      messages: consumerMessages,
    });
    const consumerRunIds = uniqueStrings([
      ...runIdsFromToolCalls(consumerCalls),
      ...(
        await runIdsFromExecutionLogs(baseUrl, {
          actorId: liveRepairConsumerAgentId,
          familyId,
          toolName,
          after: setup.promotedAt,
        })
      ).runIds,
    ]);
    scenarioBase.runIds.push(...consumerRunIds);
    const bucket = await waitForOpenFailureBucket(baseUrl, {
      familyId,
      toolName,
      generationId: setup.generationId,
    });
    const bucketId = bucket["id"];
    scenarioBase.failureBucketIds.push(bucketId);

    const repairSessionId = randomUUID();
    const failingRunId = consumerRunIds[0] ?? "(unknown)";
    const repairPrompt = [
      "You are the Tool Developer agent.",
      "Load the hosted integrations lifecycle skill if it is not already loaded in this turn.",
      "Repair the hosted integration code failure below using only hosted_tool_* lifecycle tools.",
      "",
      `family_id: ${familyId}`,
      `tool_name: ${toolName}`,
      `bucket_id: ${bucketId}`,
      `failing_run_id: ${failingRunId}`,
      `active_generation_id: ${setup.generationId}`,
      "",
      "Required repair behavior:",
      "1. Inspect the failure bucket and failing run.",
      "2. Inspect focused source for the tool before patching.",
      "3. Acquire the family lock and create a draft from current source.",
      "4. Patch only the hosted family source so text='boom' returns a normal result instead of raising.",
      `5. Add or update regression example ${regressionExampleId} with args {"text":"boom"}.`,
      "6. Validate, promote, debug-run the repaired generation, and close the failure bucket with draft, generation, and regression example evidence.",
      "Do not edit platform code, Agent Settings, environment labels, registry naming, remote MCP config, or any managed_* compatibility path.",
      "Do not call remote MCP tools.",
      "After closing the bucket, answer in one concise sentence.",
    ].join("\n");
    scenarioBase.prompts.push(repairPrompt);
    scenarioBase.sessionIds.push(repairSessionId);
    const repairChat = await postJson(baseUrl, "/api/chat", {
      agentId: "tool-developer",
      sessionId: repairSessionId,
      messages: [
        {
          id: randomUUID(),
          role: "user",
          parts: [{ type: "text", text: repairPrompt }],
        },
      ],
    });
    if (repairChat.status !== 200) {
      return failedScenario(scenarioBase, [
        `repair chat returned HTTP ${repairChat.status}: ${await safeResponseText(repairChat)}`,
      ]);
    }
    const repairMessages = await waitForSessionMessagesWithTool(
      baseUrl,
      repairSessionId,
      "hosted_tool_failure_bucket_close",
    );
    const repairCalls = extractLiveHostedToolCallsFromMessageHistory({
      agentId: "tool-developer",
      sessionId: repairSessionId,
      messages: repairMessages,
    });
    const messageIds = uniqueStrings(
      repairMessages
        .map((message) => message.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );
    const repairedGenerationIds = uniqueStrings([
      ...scenarioBase.generationIds,
      ...generationIdsFromToolCallArgs(repairCalls),
      ...generationIdsFromToolCalls(repairCalls),
    ]);
    const repairedRunIds = uniqueStrings([
      ...scenarioBase.runIds,
      ...runIdsFromToolCalls(repairCalls),
    ]);
    const scenario: LiveHostedToolScenarioEvidence = {
      ...scenarioBase,
      status: "pass",
      diagnostics: [],
      messageIds,
      toolCalls: repairCalls,
      generationIds: repairedGenerationIds,
      runIds: repairedRunIds,
      failureBucketIds: uniqueStrings(scenarioBase.failureBucketIds),
    };
    const analysis = analyzeToolDeveloperRepairBehaviorEvidence(scenario, {
      familyId,
      toolName,
      bucketId,
    });
    return {
      ...scenario,
      status: analysis.status,
      diagnostics: analysis.diagnostics,
    };
  } catch (error) {
    return failedScenario(scenarioBase, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
}

async function catalogRefreshBoundaryScenario(
  baseUrl: string,
  model: { provider?: string; model?: string },
): Promise<LiveHostedToolScenarioEvidence> {
  const suffix = Date.now().toString(36);
  const familyId = `catalog-live-${suffix}`;
  const toolName = "catalog_echo";
  const hostedToolName = buildHostedToolName({ familyId, toolName });
  const scenarioBase: ScenarioEvidenceBase = {
    id: "live-catalog-refresh-agent-settings-boundary",
    guidance: "prompt_guided",
    prompts: [] as string[],
    agentIds: [liveCatalogGrantedAgentId, liveCatalogUngrantedAgentId],
    sessionIds: [] as string[],
    generationIds: [] as string[],
    runIds: [] as string[],
    failureBucketIds: [] as string[],
    catalogNoticeIds: [] as string[],
    artifactPaths: [] as string[],
  };

  try {
    await upsertLiveAgent(baseUrl, {
      id: liveCatalogGrantedAgentId,
      name: "Live Catalog Granted",
      role: "Open-session catalog refresh acceptance agent.",
      model,
      persona:
        "Use hosted_tool_help before unfamiliar hosted tools. When a requested hosted tool is available, call it exactly once.",
      tools: ["hosted_tool_help", hostedToolName],
      hostedIntegrationBindings: [agentHostedBinding(familyId, toolName)],
    });
    await upsertLiveAgent(baseUrl, {
      id: liveCatalogUngrantedAgentId,
      name: "Live Catalog Ungranted",
      role: "Negative open-session catalog refresh acceptance agent.",
      model,
      persona:
        "Do not claim access to hosted tools that are not available in your tool list.",
      tools: [`mcp_integration-hub__${toolName}`],
      hostedIntegrationBindings: [],
    });

    const grantedSessionId = randomUUID();
    const ungrantedSessionId = randomUUID();
    scenarioBase.sessionIds.push(grantedSessionId, ungrantedSessionId);

    const grantedWarmupPrompt = [
      "This is a warm-up turn before a hosted tool is promoted.",
      "Do not call any tool. Reply with exactly: ready for catalog refresh.",
    ].join("\n");
    const ungrantedWarmupPrompt = [
      "This is a warm-up turn before a hosted tool is promoted.",
      "Do not call any tool. Reply with exactly: no hosted grant.",
    ].join("\n");
    scenarioBase.prompts.push(grantedWarmupPrompt, ungrantedWarmupPrompt);

    await postLiveChat(baseUrl, liveCatalogGrantedAgentId, grantedSessionId, grantedWarmupPrompt);
    await waitForAssistantMessagesAtLeast(baseUrl, grantedSessionId, 1);
    await postLiveChat(
      baseUrl,
      liveCatalogUngrantedAgentId,
      ungrantedSessionId,
      ungrantedWarmupPrompt,
    );
    await waitForAssistantMessagesAtLeast(baseUrl, ungrantedSessionId, 1);

    const promoted = await createCatalogRefreshFamily(baseUrl, {
      familyId,
      toolName,
    });
    scenarioBase.generationIds.push(promoted.generationId);

    const grantedPrompt = [
      `A new hosted tool should now be available: ${hostedToolName}.`,
      `First call hosted_tool_help for ${hostedToolName} with brief tool detail and examples.`,
      `Then call ${hostedToolName} exactly once with {"text":"catalog-refresh"}.`,
      "Do not call remote MCP or managed_* tools. After the result, answer in one concise sentence.",
    ].join("\n");
    scenarioBase.prompts.push(grantedPrompt);
    await postLiveChat(baseUrl, liveCatalogGrantedAgentId, grantedSessionId, grantedPrompt);
    const grantedMessages = await waitForSessionMessagesWithTool(
      baseUrl,
      grantedSessionId,
      hostedToolName,
    );

    const ungrantedPrompt = [
      `If ${hostedToolName} is available to you, call it with {"text":"denied"}.`,
      "If it is not available, do not call any tool and answer: hosted tool not available.",
    ].join("\n");
    scenarioBase.prompts.push(ungrantedPrompt);
    await postLiveChat(
      baseUrl,
      liveCatalogUngrantedAgentId,
      ungrantedSessionId,
      ungrantedPrompt,
    );
    const ungrantedMessages = await waitForAssistantMessagesAtLeast(
      baseUrl,
      ungrantedSessionId,
      2,
    );

    const grantedCalls = extractLiveHostedToolCallsFromMessageHistory({
      agentId: liveCatalogGrantedAgentId,
      sessionId: grantedSessionId,
      messages: grantedMessages,
    });
    const ungrantedCalls = extractLiveHostedToolCallsFromMessageHistory({
      agentId: liveCatalogUngrantedAgentId,
      sessionId: ungrantedSessionId,
      messages: ungrantedMessages,
    });
    const notices = [
      ...(await catalogNoticesFromTimeline(baseUrl, grantedSessionId)),
      ...(await catalogNoticesFromTimeline(baseUrl, ungrantedSessionId)),
    ];
    const directDenied = await postJson(baseUrl, "/api/hosted-integrations/invoke", {
      actor: { id: liveCatalogUngrantedAgentId, kind: "agent", roles: ["agent"] },
      familyId,
      toolName,
      args: { text: "remote-mcp-boundary" },
      hostedToolBindings: [],
      requestedEnvironment: "test_debug",
    });
    const directDeniedBody = await safeJson(directDenied);
    const directDeniedError = isRecord(directDeniedBody?.["error"])
      ? directDeniedBody["error"]
      : null;
    const remoteMcpBoundaryOk =
      directDenied.status === 403 &&
      directDeniedError?.["code"] === "binding_missing";
    const allMessages = [...grantedMessages, ...ungrantedMessages];
    const scenario: LiveHostedToolScenarioEvidence = {
      ...scenarioBase,
      status: "pass",
      diagnostics: remoteMcpBoundaryOk
        ? []
        : [
            `Remote MCP boundary direct invoke did not fail with binding_missing: HTTP ${directDenied.status} ${summarizeJson(directDeniedBody)}`,
          ],
      messageIds: uniqueStrings(
        allMessages
          .map((message) => message.id)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
      toolCalls: [...grantedCalls, ...ungrantedCalls],
      generationIds: uniqueStrings([
        ...scenarioBase.generationIds,
        ...generationIdsFromToolCalls(grantedCalls),
      ]),
      runIds: uniqueStrings(runIdsFromToolCalls(grantedCalls)),
      failureBucketIds: [],
      catalogNoticeIds: uniqueStrings(
        notices
          .map((notice) => notice.id)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
      artifactPaths: [],
    };
    const analysis = analyzeCatalogRefreshEvidence(scenario, {
      hostedToolName,
      grantedAgentId: liveCatalogGrantedAgentId,
      ungrantedAgentId: liveCatalogUngrantedAgentId,
      notices,
      modelContextNoticeDetected:
        messageHistoryContainsCatalogNotice(grantedMessages) ||
        messageHistoryContainsCatalogNotice(ungrantedMessages),
      remoteMcpBoundaryOk,
    });
    return {
      ...scenario,
      status: analysis.status,
      diagnostics: [...scenario.diagnostics, ...analysis.diagnostics],
    };
  } catch (error) {
    return failedScenario(scenarioBase, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
}

async function liveParityMatrixScenario(
  service: HostedIntegrationService,
): Promise<LiveHostedToolScenarioEvidence> {
  const scenarioBase: ScenarioEvidenceBase = {
    id: "live-parity-matrix-supporting-evidence",
    guidance: "operator_instrumented",
    prompts: [] as string[],
    agentIds: ["agent:live-parity-runner"],
    sessionIds: [] as string[],
    generationIds: [] as string[],
    runIds: [] as string[],
    failureBucketIds: [] as string[],
    catalogNoticeIds: [] as string[],
    artifactPaths: [] as string[],
  };

  try {
    const parityResults: NonNullable<
      LiveHostedToolScenarioEvidence["parityResults"]
    > = [];
    const diagnostics: string[] = [];
    for (const familyId of liveParityFamilyIds) {
      const selected = defaultLiveParityCasesForFamily(familyId);
      if (!selected.ok) {
        parityResults.push({
          familyId,
          status: "skipped",
          runId: `live_parity_${familyId}`,
          diagnostics: [selected.diagnostic],
          caseCount: 0,
          matchedCaseCount: 0,
          errorCaseCount: 0,
        });
        continue;
      }
      const result = await runHostedIntegrationLiveParity({
        dataDir,
        legacyMcpDataDir,
        service,
        cases: selected.cases,
        createId: () => `live_parity_${familyId}_${Date.now().toString(36)}`,
      });
      const artifactSecretScan = result.artifactPath
        ? await scanParityArtifact(result.artifactPath)
        : { ok: true, diagnostics: [] };
      diagnostics.push(...artifactSecretScan.diagnostics);
      parityResults.push({
        familyId,
        status: result.status,
        runId: result.runId,
        diagnostics: result.diagnostics,
        ...(result.artifactPath ? { artifactPath: result.artifactPath } : {}),
        caseCount: result.cases.length,
        matchedCaseCount: result.cases.filter(
          (testCase) => testCase.status === "match",
        ).length,
        errorCaseCount: result.cases.filter(
          (testCase) => testCase.status === "error",
        ).length,
      });
      if (result.artifactPath) scenarioBase.artifactPaths.push(result.artifactPath);
    }

    const requiredPassFamilyIds = liveParityRequiredPassFamilies(parityResults);
    const scenario: LiveHostedToolScenarioEvidence = {
      ...scenarioBase,
      status: "pass",
      diagnostics,
      messageIds: [],
      toolCalls: [],
      parityResults,
    };
    const analysis = analyzeLiveParityMatrixEvidence(scenario, {
      expectedFamilyIds: [...liveParityFamilyIds],
      requiredPassFamilyIds,
    });
    return {
      ...scenario,
      status:
        diagnostics.length === 0 && analysis.status === "pass" ? "pass" : "fail",
      diagnostics: [...diagnostics, ...analysis.diagnostics],
    };
  } catch (error) {
    return failedScenario(scenarioBase, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
}

async function scanParityArtifact(
  artifactPath: string,
): Promise<{ ok: boolean; diagnostics: string[] }> {
  const raw = await readFile(artifactPath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  const scan = scanLiveHostedToolAcceptanceSecrets(parsed);
  if (scan.status === "pass") return { ok: true, diagnostics: [] };
  return {
    ok: false,
    diagnostics: scan.findings.map(
      (finding) =>
        `Parity artifact secret scan failed for ${artifactPath} at ${finding.path} (${finding.rule})`,
    ),
  };
}

function liveParityRequiredPassFamilies(
  results: NonNullable<LiveHostedToolScenarioEvidence["parityResults"]>,
): string[] {
  const required: string[] = [];
  const qualys = results.find((result) => result.familyId === "qualys");
  if (!qualys) return ["qualys"];
  if (qualys.status !== "skipped") return ["qualys"];
  if (!qualys.diagnostics.every(isAcceptableLiveParitySkipDiagnostic)) {
    required.push("qualys");
  }
  return required;
}

function isAcceptableLiveParitySkipDiagnostic(diagnostic: string): boolean {
  return /not configured|disabled|expired|not source-backed|not supported/i.test(
    diagnostic,
  );
}

async function toolDeveloperLoadsSkillScenario(
  baseUrl: string,
): Promise<LiveHostedToolScenarioEvidence> {
  const sessionId = randomUUID();
  const prompt = [
    "You are the Tool Developer agent.",
    "Before doing hosted tool work, load the hosted integrations lifecycle instructions using the appropriate available tool.",
    "Do not create, edit, promote, or delete any hosted tool in this turn.",
    "After the instruction body is loaded, answer with one concise sentence.",
  ].join("\n");
  const scenarioBase: ScenarioEvidenceBase = {
    id: "tool-developer-loads-skill-from-live-message-history",
    guidance: "prompt_guided",
    prompts: [prompt],
    agentIds: ["tool-developer"],
    sessionIds: [sessionId],
    generationIds: [],
    runIds: [],
    failureBucketIds: [],
    catalogNoticeIds: [],
    artifactPaths: [],
  };

  try {
    const chatRes = await postJson(baseUrl, "/api/chat", {
      agentId: "tool-developer",
      sessionId,
      messages: [
        {
          id: randomUUID(),
          role: "user",
          parts: [{ type: "text", text: prompt }],
        },
      ],
    });
    if (chatRes.status !== 200) {
      return {
        ...scenarioBase,
        status: "fail",
        diagnostics: [
          `/api/chat returned HTTP ${chatRes.status}: ${(await chatRes.text()).slice(0, 500)}`,
        ],
        messageIds: [],
        toolCalls: [],
      };
    }

    const messages = await waitForSessionMessagesWithTool(
      baseUrl,
      sessionId,
      "skill_view",
    );
    const toolCalls = extractLiveHostedToolCallsFromMessageHistory({
      agentId: "tool-developer",
      sessionId,
      messages,
    });
    const messageIds = messages
      .map((message) => message.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const analysis = analyzeToolDeveloperBehaviorEvidence({
      ...scenarioBase,
      status: "pass",
      diagnostics: [],
      messageIds,
      toolCalls,
    });
    return {
      ...scenarioBase,
      status: analysis.status,
      diagnostics: analysis.diagnostics,
      messageIds,
      toolCalls,
    };
  } catch (error) {
    return {
      ...scenarioBase,
      status: "fail",
      diagnostics: [
        error instanceof Error ? error.message : String(error),
      ],
      messageIds: [],
      toolCalls: [],
    };
  }
}

async function createBuggyRepairFamily(
  baseUrl: string,
  input: {
    familyId: string;
    toolName: string;
    regressionExampleId: string;
  },
): Promise<{ generationId: string; promotedAt: Date }> {
  const create = await postJson(baseUrl, "/api/hosted-integrations/families", {
    familyId: input.familyId,
    name: `Repair Live ${input.familyId}`,
    toolName: input.toolName,
    lockedBy: "agent:tool-developer",
    ttlMs: 900_000,
  });
  const createBody = await safeJson(create);
  if (create.status !== 201) {
    throw new Error(
      `repair family create failed HTTP ${create.status}: ${summarizeJson(createBody)}`,
    );
  }
  const lock = isRecord(createBody?.["lock"]) ? createBody["lock"] : null;
  const draft = isRecord(createBody?.["draft"]) ? createBody["draft"] : null;
  const lockId = typeof lock?.["id"] === "string" ? lock["id"] : null;
  const draftId = typeof draft?.["id"] === "string" ? draft["id"] : null;
  if (!lockId || !draftId) {
    throw new Error(`repair family create returned no lock/draft ids`);
  }

  try {
    await putDraftFile(baseUrl, draftId, "family.yaml", {
      lockId,
      lockedBy: "agent:tool-developer",
      content: repairFamilyYaml(input.familyId, input.toolName),
    });
    await putDraftFile(baseUrl, draftId, "repair_live.py", {
      lockId,
      lockedBy: "agent:tool-developer",
      content: buggyRepairPython(input.toolName),
    });
    await putDraftFile(baseUrl, draftId, "help/repair-echo.md", {
      lockId,
      lockedBy: "agent:tool-developer",
      content:
        "Echoes the provided text. The live repair scenario intentionally starts with a code-owned failure for text boom.\n",
    });
    await upsertDraftExample(baseUrl, draftId, lockId, {
      id: "smoke_ok_text",
      familyId: input.familyId,
      toolName: input.toolName,
      category: "smoke",
      args: { text: "ok" },
    });
    const validate = await postJson(
      baseUrl,
      `/api/hosted-integrations/drafts/${encodeURIComponent(draftId)}/validate`,
      {},
    );
    const validation = await safeJson(validate);
    if (!validate.ok || validation?.["ok"] !== true) {
      throw new Error(
        `repair family validation failed HTTP ${validate.status}: ${summarizeJson(validation)}`,
      );
    }
    const promotedAt = new Date();
    const promote = await postJson(
      baseUrl,
      `/api/hosted-integrations/drafts/${encodeURIComponent(draftId)}/promote`,
      {
        actor: { id: "tool-developer", kind: "agent", roles: ["agent"] },
        lockId,
      },
    );
    const promoted = await safeJson(promote);
    if (!promote.ok || promoted?.["ok"] !== true) {
      throw new Error(
        `repair family promote failed HTTP ${promote.status}: ${summarizeJson(promoted)}`,
      );
    }
    const generation = isRecord(promoted?.["generation"])
      ? promoted["generation"]
      : null;
    const generationId =
      typeof generation?.["id"] === "string" ? generation["id"] : null;
    if (!generationId) {
      throw new Error(`repair family promote returned no generation id`);
    }
    return { generationId, promotedAt };
  } finally {
    await req(
      baseUrl,
      `/api/hosted-integrations/locks/${encodeURIComponent(lockId)}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lockedBy: "agent:tool-developer" }),
      },
    );
  }
}

async function createCatalogRefreshFamily(
  baseUrl: string,
  input: {
    familyId: string;
    toolName: string;
  },
): Promise<{ generationId: string; promotedAt: Date }> {
  const create = await postJson(baseUrl, "/api/hosted-integrations/families", {
    familyId: input.familyId,
    name: `Catalog Refresh ${input.familyId}`,
    toolName: input.toolName,
    lockedBy: "agent:tool-developer",
    ttlMs: 900_000,
  });
  const createBody = await safeJson(create);
  if (create.status !== 201) {
    throw new Error(
      `catalog family create failed HTTP ${create.status}: ${summarizeJson(createBody)}`,
    );
  }
  const lock = isRecord(createBody?.["lock"]) ? createBody["lock"] : null;
  const draft = isRecord(createBody?.["draft"]) ? createBody["draft"] : null;
  const lockId = typeof lock?.["id"] === "string" ? lock["id"] : null;
  const draftId = typeof draft?.["id"] === "string" ? draft["id"] : null;
  if (!lockId || !draftId) {
    throw new Error(`catalog family create returned no lock/draft ids`);
  }

  try {
    await putDraftFile(baseUrl, draftId, "family.yaml", {
      lockId,
      lockedBy: "agent:tool-developer",
      content: catalogRefreshFamilyYaml(input.familyId, input.toolName),
    });
    await putDraftFile(baseUrl, draftId, "catalog_refresh.py", {
      lockId,
      lockedBy: "agent:tool-developer",
      content: catalogRefreshPython(input.toolName),
    });
    await putDraftFile(baseUrl, draftId, "help/catalog-echo.md", {
      lockId,
      lockedBy: "agent:tool-developer",
      content:
        "Echoes a text value. Used by live catalog refresh acceptance to prove an already granted hosted tool becomes visible in an open session after promotion.\n",
    });
    await upsertDraftExample(baseUrl, draftId, lockId, {
      id: "smoke_catalog_refresh",
      familyId: input.familyId,
      toolName: input.toolName,
      category: "smoke",
      args: { text: "catalog-refresh" },
    });
    const validate = await postJson(
      baseUrl,
      `/api/hosted-integrations/drafts/${encodeURIComponent(draftId)}/validate`,
      {},
    );
    const validation = await safeJson(validate);
    if (!validate.ok || validation?.["ok"] !== true) {
      throw new Error(
        `catalog family validation failed HTTP ${validate.status}: ${summarizeJson(validation)}`,
      );
    }
    const promotedAt = new Date();
    const promote = await postJson(
      baseUrl,
      `/api/hosted-integrations/drafts/${encodeURIComponent(draftId)}/promote`,
      {
        actor: { id: "tool-developer", kind: "agent", roles: ["agent"] },
        lockId,
      },
    );
    const promoted = await safeJson(promote);
    if (!promote.ok || promoted?.["ok"] !== true) {
      throw new Error(
        `catalog family promote failed HTTP ${promote.status}: ${summarizeJson(promoted)}`,
      );
    }
    const generation = isRecord(promoted?.["generation"])
      ? promoted["generation"]
      : null;
    const generationId =
      typeof generation?.["id"] === "string" ? generation["id"] : null;
    if (!generationId) {
      throw new Error(`catalog family promote returned no generation id`);
    }
    return { generationId, promotedAt };
  } finally {
    await req(
      baseUrl,
      `/api/hosted-integrations/locks/${encodeURIComponent(lockId)}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lockedBy: "agent:tool-developer" }),
      },
    );
  }
}

async function putDraftFile(
  baseUrl: string,
  draftId: string,
  path: string,
  body: { lockId: string; lockedBy: string; content: string },
): Promise<void> {
  const res = await req(
    baseUrl,
    `/api/hosted-integrations/drafts/${encodeURIComponent(draftId)}/files/${path}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(
      `draft file ${path} write failed HTTP ${res.status}: ${await safeResponseText(res)}`,
    );
  }
}

async function upsertDraftExample(
  baseUrl: string,
  draftId: string,
  lockId: string,
  example: Record<string, unknown>,
): Promise<void> {
  const res = await postJson(
    baseUrl,
    `/api/hosted-integrations/drafts/${encodeURIComponent(draftId)}/examples`,
    {
      lockId,
      lockedBy: "agent:tool-developer",
      example,
    },
  );
  if (!res.ok) {
    throw new Error(
      `draft example ${String(example.id)} upsert failed HTTP ${res.status}: ${await safeResponseText(res)}`,
    );
  }
}

async function waitForOpenFailureBucket(
  baseUrl: string,
  expected: {
    familyId: string;
    toolName: string;
    generationId: string;
  },
): Promise<LiveFailureBucketRef> {
  const deadline = Date.now() + chatDeadlineMs;
  for (;;) {
    const res = await req(
      baseUrl,
      `/api/hosted-integrations/failure-buckets?actorId=tool-developer&familyId=${encodeURIComponent(
        expected.familyId,
      )}`,
    );
    if (res.ok) {
      const body = (await res.json()) as { buckets?: Array<Record<string, unknown>> };
      const bucket = (Array.isArray(body.buckets) ? body.buckets : [])
        .filter(
          (candidate) =>
            candidate["familyId"] === expected.familyId &&
            candidate["toolName"] === expected.toolName &&
            candidate["generationId"] === expected.generationId &&
            candidate["status"] === "open" &&
            typeof candidate["id"] === "string",
        )
        .sort((a, b) =>
          String(b["latestSeenAt"] ?? "").localeCompare(
            String(a["latestSeenAt"] ?? ""),
          ),
        )[0];
      if (bucket && typeof bucket["id"] === "string") {
        return {
          id: bucket["id"],
          familyId: String(bucket["familyId"]),
          toolName: String(bucket["toolName"]),
          generationId: String(bucket["generationId"]),
        };
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for open failure bucket for ${expected.familyId}/${expected.toolName}`,
      );
    }
    await sleep(500);
  }
}

function repairFamilyYaml(familyId: string, toolName: string): string {
  return `
id: ${familyId}
name: Repair Live
version: 1
runtime:
  language: python
  entrypoint: repair_live.py
  defaultTimeoutMs: 30000
  inlineResultTokenLimit: 8000
  maxConcurrency: 2
  runtimePolicy:
    filesystem: run_dir_and_family_home
    processEnv: tool_context_only
    subprocess: denied
    network: denied
  dependencyPolicy:
    installDuringInvocation: false
    allowedPackages: []
runtimeConfig:
  requiredConfigKeys: []
  requiredSecretKeys: []
tools:
  - name: ${toolName}
    title: Repair Echo
    description: Safe echo tool used by live repair acceptance.
    inputSchema:
      type: object
      properties:
        text:
          type: string
      required:
        - text
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    help:
      summary: Echoes text and is intentionally buggy for live repair acceptance.
      full: help/repair-echo.md
      parameters:
        text:
          summary: Text to echo.
`;
}

function buggyRepairPython(toolName: string): string {
  return [
    "def authenticate(ctx):",
    "    return {'mode': 'config-free'}",
    "",
    "def before_tool_call(tool_name, args, ctx, auth):",
    "    return args",
    "",
    "def after_tool_call(tool_name, args, ctx, result, auth):",
    "    return result",
    "",
    `def tool_${toolName}(args, context):`,
    "    text = args.get('text', '')",
    "    if text == 'boom':",
    "        raise RuntimeError('repair_live_unique_code_failure')",
    "    return {'echo': text, 'repaired': False}",
    "",
  ].join("\n");
}

function catalogRefreshFamilyYaml(familyId: string, toolName: string): string {
  return `
id: ${familyId}
name: Catalog Refresh
version: 1
runtime:
  language: python
  entrypoint: catalog_refresh.py
  defaultTimeoutMs: 30000
  inlineResultTokenLimit: 8000
  maxConcurrency: 2
  runtimePolicy:
    filesystem: run_dir_and_family_home
    processEnv: tool_context_only
    subprocess: denied
    network: denied
  dependencyPolicy:
    installDuringInvocation: false
    allowedPackages: []
runtimeConfig:
  requiredConfigKeys: []
  requiredSecretKeys: []
tools:
  - name: ${toolName}
    title: Catalog Echo
    description: Config-free echo tool used by live catalog refresh acceptance.
    inputSchema:
      type: object
      properties:
        text:
          type: string
      required:
        - text
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    help:
      summary: Echoes text for catalog refresh acceptance.
      full: help/catalog-echo.md
      parameters:
        text:
          summary: Text to echo.
`;
}

function catalogRefreshPython(toolName: string): string {
  return [
    "def authenticate(ctx):",
    "    return {'mode': 'config-free'}",
    "",
    "def before_tool_call(tool_name, args, ctx, auth):",
    "    return args",
    "",
    "def after_tool_call(tool_name, args, ctx, result, auth):",
    "    return result",
    "",
    `def tool_${toolName}(args, context):`,
    "    text = args.get('text', '')",
    "    return {'ok': True, 'echo': text, 'catalog_refresh': True}",
    "",
  ].join("\n");
}

async function waitForSessionMessagesWithTool(
  baseUrl: string,
  sessionId: string,
  toolName: string,
): Promise<Array<{ id?: string; role: string; parts: Array<Record<string, unknown>> }>> {
  const deadline = Date.now() + chatDeadlineMs;
  let lastAssistantText = "";
  let lastMessages: Array<{
    id?: string;
    role: string;
    parts: Array<Record<string, unknown>>;
  }> = [];
  for (;;) {
    const res = await req(baseUrl, `/api/sessions/${sessionId}/messages`);
    if (res.ok) {
      const messages = normalizeMessages(await res.json());
      lastMessages = messages;
      if (hasAvailableToolOutput(messages, toolName)) return messages;
      const assistant = [...messages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (assistant) lastAssistantText = textFromParts(assistant.parts);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for tool-${toolName}; observed ${lastMessages.length} messages. Last assistant text: ${lastAssistantText.slice(0, 500)}`,
      );
    }
    await sleep(500);
  }
}

async function waitForAssistantMessagesAtLeast(
  baseUrl: string,
  sessionId: string,
  minAssistantMessages: number,
): Promise<Array<{ id?: string; role: string; parts: Array<Record<string, unknown>> }>> {
  const deadline = Date.now() + chatDeadlineMs;
  let lastMessages: Array<{
    id?: string;
    role: string;
    parts: Array<Record<string, unknown>>;
  }> = [];
  for (;;) {
    const res = await req(baseUrl, `/api/sessions/${sessionId}/messages`);
    if (res.ok) {
      const messages = normalizeMessages(await res.json());
      lastMessages = messages;
      const assistantCount = messages.filter(
        (message) => message.role === "assistant",
      ).length;
      if (assistantCount >= minAssistantMessages) return messages;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${minAssistantMessages} assistant messages; observed ${lastMessages.length} total messages.`,
      );
    }
    await sleep(500);
  }
}

async function postLiveChat(
  baseUrl: string,
  agentId: string,
  sessionId: string,
  prompt: string,
): Promise<void> {
  const chatRes = await postJson(baseUrl, "/api/chat", {
    agentId,
    sessionId,
    messages: [
      {
        id: randomUUID(),
        role: "user",
        parts: [{ type: "text", text: prompt }],
      },
    ],
  });
  if (chatRes.status !== 200) {
    throw new Error(
      `/api/chat for ${agentId} returned HTTP ${chatRes.status}: ${await safeResponseText(chatRes)}`,
    );
  }
}

async function catalogNoticesFromTimeline(
  baseUrl: string,
  sessionId: string,
): Promise<CatalogRefreshNoticeEvidence[]> {
  const res = await req(
    baseUrl,
    `/api/sessions/${encodeURIComponent(
      sessionId,
    )}/timeline?eventType=session.tool_catalog.changed&includeForensics=0&limit=100`,
  );
  if (!res.ok) {
    throw new Error(
      `catalog notice timeline lookup failed HTTP ${res.status}: ${await safeResponseText(res)}`,
    );
  }
  const body = (await res.json()) as { events?: Array<Record<string, unknown>> };
  const events = Array.isArray(body.events) ? body.events : [];
  return events.flatMap((event) => {
    const payload = isRecord(event["payload"]) ? event["payload"] : null;
    if (!payload) return [];
    const addedToolNames = Array.isArray(payload["addedToolNames"])
      ? payload["addedToolNames"].filter(
          (toolName): toolName is string => typeof toolName === "string",
        )
      : [];
    const removedToolNames = Array.isArray(payload["removedToolNames"])
      ? payload["removedToolNames"].filter(
          (toolName): toolName is string => typeof toolName === "string",
        )
      : [];
    const addedHostedTools = Array.isArray(payload["addedHostedTools"])
      ? payload["addedHostedTools"].flatMap((tool) => {
          if (!isRecord(tool)) return [];
          return [
            {
              ...(typeof tool["toolName"] === "string"
                ? { toolName: tool["toolName"] }
                : {}),
              ...(typeof tool["grantStatus"] === "string"
                ? { grantStatus: tool["grantStatus"] }
                : {}),
            },
          ];
        })
      : [];
    return [
      {
        ...(typeof event["id"] === "string" ? { id: event["id"] } : {}),
        ...(typeof payload["agentId"] === "string"
          ? { agentId: payload["agentId"] }
          : {}),
        addedToolNames,
        removedToolNames,
        addedHostedTools,
      },
    ];
  });
}

async function upsertLiveAgent(
  baseUrl: string,
  definition: Record<string, unknown>,
): Promise<void> {
  const create = await postJson(baseUrl, "/api/agents", definition);
  if (create.status === 201) return;
  if (create.status !== 400) {
    throw new Error(
      `create agent ${String(definition.id)} failed HTTP ${create.status}: ${await safeResponseText(create)}`,
    );
  }
  const createError = await safeResponseText(create);
  const existing = await req(
    baseUrl,
    `/api/agents/${encodeURIComponent(String(definition.id))}`,
  );
  if (existing.status === 404) {
    throw new Error(
      `create agent ${String(definition.id)} failed HTTP 400: ${createError}`,
    );
  }
  if (!existing.ok) {
    throw new Error(
      `lookup agent ${String(definition.id)} failed HTTP ${existing.status}: ${await safeResponseText(existing)}`,
    );
  }
  const update = await req(
    baseUrl,
    `/api/agents/${encodeURIComponent(String(definition.id))}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(definition),
    },
  );
  if (!update.ok) {
    throw new Error(
      `update agent ${String(definition.id)} failed HTTP ${update.status}: ${await safeResponseText(update)}`,
    );
  }
}

async function generationIdsFromRuns(
  baseUrl: string,
  runIds: readonly string[],
  expected: { actorId: string; familyId: string; toolName: string },
): Promise<string[]> {
  const generationIds = new Set<string>();
  for (const runId of runIds) {
    const res = await req(
      baseUrl,
      `/api/hosted-integrations/runs/${encodeURIComponent(runId)}?actorId=${encodeURIComponent(
        expected.actorId,
      )}`,
    );
    if (!res.ok) continue;
    const body = (await res.json()) as { run?: Record<string, unknown> };
    const run = body?.run;
    if (
      run?.familyId === expected.familyId &&
      run?.toolName === expected.toolName &&
      run?.status === "succeeded" &&
      typeof run?.generationId === "string"
    ) {
      generationIds.add(run.generationId);
    }
  }
  return [...generationIds];
}

async function directHostedInvokeDiagnostic(
  baseUrl: string,
  input: {
    actorId: string;
    familyId: string;
    toolName: string;
    args: Record<string, unknown>;
  },
): Promise<{
  diagnostics: string[];
  runIds: string[];
  generationIds: string[];
}> {
  const res = await postJson(baseUrl, "/api/hosted-integrations/invoke", {
    actor: { id: input.actorId, kind: "agent", roles: ["agent"] },
    familyId: input.familyId,
    toolName: input.toolName,
    args: input.args,
    hostedToolBindings: [
      gatewayHostedBinding(input.actorId, input.familyId, input.toolName),
    ],
    requestedEnvironment: "test_debug",
  });
  const body = await safeJson(res);
  const runId = typeof body?.["runId"] === "string" ? body["runId"] : null;
  const generationId =
    typeof body?.["generationId"] === "string" ? body["generationId"] : null;
  const diagnostics = [
    `Direct hosted invoke diagnostic returned HTTP ${res.status}: ${summarizeJson(body)}`,
  ];
  return {
    diagnostics,
    runIds: runId ? [runId] : [],
    generationIds: generationId ? [generationId] : [],
  };
}

async function ensureLatestGenerationRuntimeConfig(
  baseUrl: string,
  familyId: string,
): Promise<{ diagnostics: string[]; generationIds: string[] }> {
  const latest = await latestGenerationDetail(baseUrl, familyId);
  if (latest?.runtimeConfig) {
    return { diagnostics: [], generationIds: [String(latest.id)] };
  }

  const diagnostics: string[] = [
    latest
      ? `Latest ${familyId} generation ${String(latest.id)} is missing runtimeConfig; promoting a fresh test-env generation from current hosted source.`
      : `No active ${familyId} generation detail found; promoting a fresh test-env generation from current hosted source.`,
  ];
  let lockId: string | null = null;
  try {
    const lockRes = await postJson(
      baseUrl,
      `/api/hosted-integrations/families/${encodeURIComponent(familyId)}/lock`,
      { lockedBy: "agent:tool-developer", ttlMs: 900_000 },
    );
    const lockBody = await safeJson(lockRes);
    if (lockRes.status !== 201) {
      diagnostics.push(
        `Could not acquire ${familyId} promotion lock: HTTP ${lockRes.status} ${summarizeJson(lockBody)}`,
      );
      return { diagnostics, generationIds: [] };
    }
    const lock = isRecord(lockBody?.["lock"]) ? lockBody["lock"] : null;
    lockId = typeof lock?.["id"] === "string" ? lock["id"] : null;
    if (!lockId) {
      diagnostics.push(`Could not read ${familyId} lock id from ${summarizeJson(lockBody)}`);
      return { diagnostics, generationIds: [] };
    }

    const draftRes = await postJson(
      baseUrl,
      `/api/hosted-integrations/families/${encodeURIComponent(familyId)}/drafts`,
      { lockId },
    );
    const draftBody = await safeJson(draftRes);
    if (draftRes.status !== 201) {
      diagnostics.push(
        `Could not create ${familyId} runtimeConfig draft: HTTP ${draftRes.status} ${summarizeJson(draftBody)}`,
      );
      return { diagnostics, generationIds: [] };
    }
    const draft = isRecord(draftBody?.["draft"]) ? draftBody["draft"] : null;
    const draftId = typeof draft?.["id"] === "string" ? draft["id"] : null;
    if (!draftId) {
      diagnostics.push(`Could not read ${familyId} draft id from ${summarizeJson(draftBody)}`);
      return { diagnostics, generationIds: [] };
    }

    const validateRes = await postJson(
      baseUrl,
      `/api/hosted-integrations/drafts/${encodeURIComponent(draftId)}/validate`,
      {},
    );
    const validation = await safeJson(validateRes);
    if (!validateRes.ok || validation?.["ok"] !== true) {
      diagnostics.push(
        `RuntimeConfig draft validation failed: HTTP ${validateRes.status} ${summarizeJson(validation)}`,
      );
      return { diagnostics, generationIds: [] };
    }

    const promoteRes = await postJson(
      baseUrl,
      `/api/hosted-integrations/drafts/${encodeURIComponent(draftId)}/promote`,
      {
        actor: { id: "tool-developer", kind: "agent", roles: ["agent"] },
        lockId,
      },
    );
    const promoted = await safeJson(promoteRes);
    if (!promoteRes.ok || promoted?.["ok"] !== true) {
      diagnostics.push(
        `RuntimeConfig generation promotion failed: HTTP ${promoteRes.status} ${summarizeJson(promoted)}`,
      );
      return { diagnostics, generationIds: [] };
    }
    const generation = isRecord(promoted?.["generation"])
      ? promoted["generation"]
      : null;
    const generationId =
      typeof generation?.["id"] === "string" ? generation["id"] : null;
    const hasRuntimeConfig = Boolean(generation?.["runtimeConfig"]);
    diagnostics.push(
      `Promoted ${familyId} generation ${generationId ?? "(unknown)"} for runtimeConfig rectification; runtimeConfigPresent=${hasRuntimeConfig}.`,
    );
    return {
      diagnostics,
      generationIds: generationId ? [generationId] : [],
    };
  } finally {
    if (lockId) {
      await req(
        baseUrl,
        `/api/hosted-integrations/locks/${encodeURIComponent(lockId)}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lockedBy: "agent:tool-developer" }),
        },
      );
    }
  }
}

async function latestGenerationDetail(
  baseUrl: string,
  familyId: string,
): Promise<Record<string, unknown> | null> {
  const res = await req(
    baseUrl,
    `/api/hosted-integrations/generations?familyId=${encodeURIComponent(familyId)}`,
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { generations?: Array<Record<string, unknown>> };
  const generations = Array.isArray(body.generations) ? body.generations : [];
  const latest = generations
    .filter((generation) => generation["status"] === "active")
    .sort((a, b) =>
      String(b["promotedAt"] ?? "").localeCompare(String(a["promotedAt"] ?? "")),
    )[0];
  const generationId =
    latest && typeof latest["id"] === "string" ? latest["id"] : null;
  if (!generationId) return null;
  const detail = await req(
    baseUrl,
    `/api/hosted-integrations/generations/${encodeURIComponent(generationId)}`,
  );
  if (!detail.ok) return null;
  const detailBody = (await detail.json()) as { generation?: Record<string, unknown> };
  return isRecord(detailBody.generation) ? detailBody.generation : null;
}

async function runIdsFromExecutionLogs(
  baseUrl: string,
  expected: {
    actorId: string;
    familyId: string;
    toolName: string;
    after: Date;
  },
): Promise<{ runIds: string[]; diagnostics: string[] }> {
  const res = await req(
    baseUrl,
    `/api/hosted-integrations/runs?actorId=tool-developer&familyId=${encodeURIComponent(
      expected.familyId,
    )}&toolName=${encodeURIComponent(expected.toolName)}&limit=10`,
  );
  if (!res.ok) {
    return {
      runIds: [],
      diagnostics: [
        `Could not list hosted execution logs for run-id evidence: HTTP ${res.status}: ${await safeResponseText(res)}`,
      ],
    };
  }
  const body = (await res.json()) as { runs?: Array<Record<string, unknown>> };
  const runs = Array.isArray(body.runs) ? body.runs : [];
  return {
    runIds: runs
      .filter(
        (run) =>
          run["actorId"] === expected.actorId &&
          run["familyId"] === expected.familyId &&
          run["toolName"] === expected.toolName &&
          typeof run["runId"] === "string" &&
          typeof run["startedAt"] === "string" &&
          Date.parse(run["startedAt"]) >= expected.after.getTime(),
      )
      .map((run) => run["runId"])
      .filter((runId): runId is string => typeof runId === "string"),
    diagnostics: [],
  };
}

function runIdsFromToolCalls(
  toolCalls: readonly { resultSummary?: Record<string, unknown> }[],
): string[] {
  return uniqueStrings(
    toolCalls
      .map((call) => call.resultSummary?.["runId"])
      .filter((value): value is string => typeof value === "string"),
  );
}

function generationIdsFromToolCalls(
  toolCalls: readonly { resultSummary?: Record<string, unknown> }[],
): string[] {
  return uniqueStrings(
    toolCalls
      .map((call) => call.resultSummary?.["generationId"])
      .filter((value): value is string => typeof value === "string"),
  );
}

function generationIdsFromToolCallArgs(
  toolCalls: readonly { argsSummary?: Record<string, unknown> }[],
): string[] {
  return uniqueStrings(
    toolCalls
      .flatMap((call) => [
        call.argsSummary?.["generation_id"],
        call.argsSummary?.["generationId"],
      ])
      .filter((value): value is string => typeof value === "string"),
  );
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function agentHostedBinding(familyId: string, toolName: string) {
  return {
    familyId,
    toolName,
    allowedEnvironments: ["test_debug"],
    defaultEnvironment: "test_debug",
    generationPin: { type: "current" },
    bindingKind: "agent",
    updatedAt: new Date().toISOString(),
    updatedBy: "human:live-acceptance",
  };
}

function gatewayHostedBinding(
  agentId: string,
  familyId: string,
  toolName: string,
) {
  return {
    agentId,
    ...agentHostedBinding(familyId, toolName),
  };
}

function safeQualysCountArgs(): Record<string, unknown> {
  return {
    filter_body: {
      filters: [
        {
          field: "asset.name",
          operator: "EQUALS",
          value: "definitely-missing-host",
        },
      ],
    },
  };
}

function skippedScenario(
  base: ScenarioEvidenceBase,
  diagnostics: string[],
): LiveHostedToolScenarioEvidence {
  return {
    ...base,
    status: "skipped",
    diagnostics,
    messageIds: [],
    toolCalls: [],
  };
}

function failedScenario(
  base: ScenarioEvidenceBase,
  diagnostics: string[],
): LiveHostedToolScenarioEvidence {
  return {
    ...base,
    status: "fail",
    diagnostics,
    messageIds: [],
    toolCalls: [],
  };
}

function normalizeMessages(
  value: unknown,
): Array<{ id?: string; role: string; parts: Array<Record<string, unknown>> }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const message = item as {
      id?: unknown;
      role?: unknown;
      parts?: unknown;
    };
    if (typeof message.role !== "string" || !Array.isArray(message.parts)) {
      return [];
    }
    return [
      {
        ...(typeof message.id === "string" ? { id: message.id } : {}),
        role: message.role,
        parts: message.parts.filter(
          (part): part is Record<string, unknown> =>
            Boolean(part) && typeof part === "object" && !Array.isArray(part),
        ),
      },
    ];
  });
}

function hasAvailableToolOutput(
  messages: Array<{ role: string; parts: Array<Record<string, unknown>> }>,
  toolName: string,
): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some(
        (part) =>
          part["type"] === `tool-${toolName}` &&
          part["state"] === "output-available",
      ),
  );
}

function messageHistoryContainsCatalogNotice(
  messages: Array<{ role: string; parts: Array<Record<string, unknown>> }>,
): boolean {
  return messages.some((message) =>
    message.parts.some((part) => {
      if (part["type"] === "tool_catalog_notice") return true;
      if (part["type"] === "data-tool_catalog_notice") return true;
      return (
        typeof part["text"] === "string" &&
        part["text"].includes("Tool catalog updated:")
      );
    }),
  );
}

function textFromParts(parts: Array<Record<string, unknown>>): string {
  return parts
    .map((part) => (typeof part["text"] === "string" ? part["text"] : ""))
    .join("\n");
}

function req(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", "127.0.0.1");
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${authToken}`);
  }
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(chatDeadlineMs),
  });
}

function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return req(baseUrl, path, {
    ...init,
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await res.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function safeResponseText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

function summarizeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "string" && item.length > 240) {
      return `${item.slice(0, 237)}...`;
    }
    return item;
  }).slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonBlock(value: unknown): string {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

async function closeServer(): Promise<void> {
  const activeServer = server;
  server = null;
  if (!activeServer) return;
  const closer = activeServer as ServerType & {
    closeAllConnections?: () => void;
    closeIdleConnections?: () => void;
  };
  const closed = new Promise<void>((resolve, reject) => {
    activeServer.close((error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  const forced = sleep(1_000).then(() => {
    closer.closeIdleConnections?.();
    closer.closeAllConnections?.();
  });
  await Promise.race([closed, forced]);
}

function positivePort(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`invalid OPENACME_E2E_PORT: ${value}`);
  }
  return parsed;
}

function positiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid positive integer: ${value}`);
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          console.error(`${label} did not finish within ${ms}ms; continuing`);
          resolve(undefined);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

main()
  .then(() => {
    process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          status: "fail",
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  });
