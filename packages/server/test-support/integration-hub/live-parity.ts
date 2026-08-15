import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { loadGlobalMcpServers, type MCPServerConfig } from "@openacme/config";
import {
  createFileHostedIntegrationService,
  JsonObjectSchema,
  type HostedIntegrationHostedToolBinding,
  type HostedIntegrationService,
  type JsonObject,
} from "@openacme/hosted-integrations";
import {
  FIRST_LEGACY_INTEGRATION_HUB_REPLACEMENT_FAMILY,
  LEGACY_INTEGRATION_HUB_DEFENDER_ALERT_SOURCE_BACKED_FAMILY,
  LEGACY_INTEGRATION_HUB_FIVE_READONLY_SOURCE_BACKED_FAMILY,
  LEGACY_INTEGRATION_HUB_MDE_SOURCE_BACKED_FAMILY,
  LEGACY_INTEGRATION_HUB_MSGRAPH_SOURCE_BACKED_FAMILY,
  LEGACY_INTEGRATION_HUB_REPLACEMENT_SECURITY_FAMILIES,
  type LegacyIntegrationHubReplacementFamilyFixture,
} from "../../../hosted-integrations/test-support/integration-hub/fixtures.js";
import { MCPClient } from "@openacme/mcp-client";
import { ToolRegistry } from "@openacme/tools";

export interface LiveParityToolCase {
  familyId: string;
  toolName: string;
  hostedToolName: string;
  legacyServerName: string;
  legacyMcpToolName: string;
  args: Record<string, unknown>;
  hostedArgs?: Record<string, unknown>;
  legacyArgs?: Record<string, unknown>;
}

export interface LiveParityRunnerOptions {
  dataDir: string;
  legacyMcpDataDir?: string;
  familyConfig?: Record<string, string>;
  familySecrets?: Record<string, string>;
  service?: HostedIntegrationService;
  hostedClient?: HostedParityClient;
  legacyClient?: LegacyMcpParityClient;
  cases?: LiveParityToolCase[];
  now?: () => Date;
  createId?: () => string;
  writeEvidence?: boolean;
}

export interface LegacyMcpParityClient {
  connect(serverName: string, config: MCPServerConfig): Promise<{
    ok: boolean;
    diagnostic?: string;
  }>;
  callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string>;
  close(): Promise<void>;
}

export interface HostedParityClient {
  prepare(
    config: Record<string, string>,
    secrets: Record<string, string>,
  ): Promise<void>;
  callTool(testCase: LiveParityToolCase): Promise<unknown>;
  close(): Promise<void>;
}

export interface LiveParityRunResult {
  status: "pass" | "fail" | "skipped";
  runId: string;
  diagnostics: string[];
  artifactPath?: string;
  cases: LiveParityCaseResult[];
}

export interface LiveParityCaseResult {
  familyId: string;
  toolName: string;
  hostedToolName: string;
  legacyMcpToolName: string;
  status: "match" | "mismatch" | "error";
  comparison: "match" | "mismatch" | "not_compared";
  hosted: SanitizedToolResult;
  legacy: SanitizedToolResult;
  hostedRunId?: string;
  failureBucketId?: string;
}

export interface SanitizedToolResult {
  ok: boolean;
  hash: string;
  summary: Record<string, unknown>;
  runId?: string;
  failureBucketId?: string;
  error?: {
    code?: string;
    message: string;
  };
}

const DEFAULT_ENVIRONMENT = "test_debug";
const DEFAULT_ACTOR_ID = "agent:live-parity-runner";
const SOURCE_BACKED_LIVE_PARITY_FAMILIES = [
  "qualys",
  "splunk",
  "msgraph",
  "mde",
  "defender-alert",
] as const;

export function liveParityHostedToolBinding(
  testCase: Pick<LiveParityToolCase, "familyId" | "toolName">,
  now: () => Date = () => new Date(),
): HostedIntegrationHostedToolBinding {
  return {
    agentId: DEFAULT_ACTOR_ID,
    familyId: testCase.familyId,
    toolName: testCase.toolName,
    allowedEnvironments: [DEFAULT_ENVIRONMENT],
    defaultEnvironment: DEFAULT_ENVIRONMENT,
    generationPin: { type: "current" },
    bindingKind: "internal",
    purpose: "live-parity",
    updatedAt: now().toISOString(),
    updatedBy: DEFAULT_ACTOR_ID,
  };
}

export async function runHostedIntegrationLiveParity(
  options: LiveParityRunnerOptions,
): Promise<LiveParityRunResult> {
  const now = options.now ?? (() => new Date());
  const runId = options.createId?.() ?? `live_parity_${randomUUID()}`;
  const diagnostics: string[] = [];
  const legacyMcpDataDir = options.legacyMcpDataDir ?? options.dataDir;
  const cases = options.cases ?? defaultQualysLiveParityCases();
  const familyId = cases[0]?.familyId ?? "qualys";
  if (cases.some((testCase) => testCase.familyId !== familyId)) {
    return skipped(runId, ["live parity cases must target one family per run"]);
  }
  const serverName = cases[0]?.legacyServerName ?? "integration-hub";
  const legacyConfig = loadGlobalMcpServers(legacyMcpDataDir)[serverName];

  if (!legacyConfig) {
    return skipped(runId, [
      `remote MCP server '${serverName}' is not configured in ${legacyMcpDataDir}/mcp.json`,
    ]);
  }
  if (legacyConfig.enabled === false) {
    return skipped(runId, [`remote MCP server '${serverName}' is disabled`]);
  }

  const liveConfig = liveParityConfigFromOptions(
    familyId,
    options,
    legacyConfig,
    now(),
  );
  if (!liveConfig.ok) return skipped(runId, liveConfig.diagnostics);

  const service = options.service;
  const hostedClient =
    options.hostedClient ??
    new DefaultHostedParityClient(
      service ??
        createFileHostedIntegrationService({
          dataDir: options.dataDir,
        }),
      familyId,
    );
  const ownsHostedClient = !options.hostedClient;
  const legacyClient =
    options.legacyClient ?? new DefaultLegacyMcpParityClient();
  const ownsLegacyClient = !options.legacyClient;

  try {
    await hostedClient.prepare(liveConfig.config, liveConfig.secrets);
    const connected = await legacyClient.connect(serverName, legacyConfig);
    if (!connected.ok) {
      return skipped(runId, [
        connected.diagnostic ??
          `remote MCP server '${serverName}' could not be connected`,
      ]);
    }

    const results: LiveParityCaseResult[] = [];
    for (const testCase of cases) {
      results.push(await runParityCase(hostedClient, legacyClient, testCase));
    }

    const status = results.every((result) => result.status === "match")
      ? "pass"
      : "fail";
    const result: LiveParityRunResult = {
      status,
      runId,
      diagnostics,
      cases: results,
    };
    if (options.writeEvidence !== false) {
      result.artifactPath = await writeEvidenceArtifact(options.dataDir, result);
    }
    return result;
  } finally {
    if (ownsLegacyClient) await legacyClient.close();
    if (ownsHostedClient) await hostedClient.close();
  }
}

export function defaultQualysLiveParityCases(): LiveParityToolCase[] {
  return liveParityCasesFromFixture(
    LEGACY_INTEGRATION_HUB_FIVE_READONLY_SOURCE_BACKED_FAMILY,
  ).map((testCase) => ({
    ...testCase,
    ...qualysLegacyArgumentOverrides(testCase.toolName, testCase.args),
  }));
}

export function defaultSplunkLiveParityCases(): LiveParityToolCase[] {
  return liveParityCasesFromFixture(
    FIRST_LEGACY_INTEGRATION_HUB_REPLACEMENT_FAMILY,
  ).map((testCase) => ({
    ...testCase,
    ...splunkLegacyArgumentOverrides(testCase.args),
  }));
}

export function defaultMsGraphLiveParityCases(): LiveParityToolCase[] {
  return liveParityCasesFromFixture(
    LEGACY_INTEGRATION_HUB_MSGRAPH_SOURCE_BACKED_FAMILY,
  );
}

export function defaultMdeLiveParityCases(): LiveParityToolCase[] {
  return liveParityCasesFromFixture(
    LEGACY_INTEGRATION_HUB_MDE_SOURCE_BACKED_FAMILY,
  );
}

export function defaultDefenderAlertLiveParityCases(): LiveParityToolCase[] {
  return liveParityCasesFromFixture(
    LEGACY_INTEGRATION_HUB_DEFENDER_ALERT_SOURCE_BACKED_FAMILY,
  );
}

export function defaultLiveParityCasesForFamily(
  familyId: string,
):
  | { ok: true; cases: LiveParityToolCase[] }
  | { ok: false; diagnostic: string } {
  if (familyId === "qualys") {
    return { ok: true, cases: defaultQualysLiveParityCases() };
  }
  if (familyId === "splunk") {
    return { ok: true, cases: defaultSplunkLiveParityCases() };
  }
  if (familyId === "msgraph") {
    return { ok: true, cases: defaultMsGraphLiveParityCases() };
  }
  if (familyId === "mde") {
    return { ok: true, cases: defaultMdeLiveParityCases() };
  }
  if (familyId === "defender-alert") {
    return { ok: true, cases: defaultDefenderAlertLiveParityCases() };
  }
  return {
    ok: false,
    diagnostic: `live parity family '${familyId}' is not source-backed yet; supported families: ${SOURCE_BACKED_LIVE_PARITY_FAMILIES.join(", ")}`,
  };
}

function liveParityCasesFromFixture(
  fixture: LegacyIntegrationHubReplacementFamilyFixture,
): LiveParityToolCase[] {
  return fixture.examples.map((example) => {
    const mapping = fixture.replacementMappings.find(
      (candidate) => candidate.hostedToolName === example.toolName,
    );
    if (!mapping) {
      throw new Error(`missing legacy mapping for ${example.toolName}`);
    }
    return {
      familyId: example.familyId,
      toolName: example.toolName,
      hostedToolName: mapping.hostedRegistryToolName,
      legacyServerName: "integration-hub",
      legacyMcpToolName: mapping.legacyMcpToolName,
      args: example.args,
    };
  });
}

function qualysLegacyArgumentOverrides(
  toolName: string,
  hostedArgs: Record<string, unknown>,
): Pick<LiveParityToolCase, "hostedArgs" | "legacyArgs"> {
  if (toolName === "qualys_cloud_agent_hostasset_count") {
    return {
      hostedArgs: {},
      legacyArgs: {
        criteria: [
          { field: "tagName", operator: "EQUALS", value: "Cloud Agent" },
        ],
      },
    };
  }
  if (toolName === "qualys_cloud_agent_hostasset_search") {
    return {
      hostedArgs: {
        ...withoutKey(hostedArgs, "filter_body"),
        page_size: 2,
        max_pages: 1,
      },
      legacyArgs: {
        criteria: [
          { field: "tagName", operator: "EQUALS", value: "Cloud Agent" },
        ],
        limit: 2,
      },
    };
  }
  return {};
}

function splunkLegacyArgumentOverrides(
  hostedArgs: Record<string, unknown>,
): Pick<LiveParityToolCase, "hostedArgs" | "legacyArgs"> {
  return {
    legacyArgs: withoutKey(hostedArgs, "limit"),
  };
}

function liveParityConfigFromOptions(
  familyId: string,
  options: LiveParityRunnerOptions,
  legacyConfig: MCPServerConfig,
  now: Date,
):
  | {
      ok: true;
      config: Record<string, string>;
      secrets: Record<string, string>;
    }
  | { ok: false; diagnostics: string[] } {
  if (familyId === "qualys") {
    return liveQualysConfigFromOptions(options, legacyConfig);
  }
  if (familyId === "splunk") {
    return liveSplunkConfigFromOptions(options, legacyConfig, now);
  }
  if (familyId === "msgraph") {
    return liveMsGraphConfigFromOptions(options, legacyConfig);
  }
  if (familyId === "mde") {
    return liveMdeConfigFromOptions(options, legacyConfig);
  }
  if (familyId === "defender-alert") {
    return liveDefenderAlertConfigFromOptions(options, legacyConfig);
  }
  return {
    ok: false,
    diagnostics: [`live parity family '${familyId}' is not supported`],
  };
}

function liveDefenderAlertConfigFromOptions(
  options: LiveParityRunnerOptions,
  legacyConfig: MCPServerConfig,
):
  | {
      ok: true;
      config: Record<string, string>;
      secrets: Record<string, string>;
    }
  | { ok: false; diagnostics: string[] } {
  const source = liveConfigSource(options, legacyConfig);
  const tenantId = nonEmpty(source["DEFENDER_TENANT_ID"]);
  const clientId = nonEmpty(source["DEFENDER_CLIENT_ID"]);
  const clientSecret = nonEmpty(source["DEFENDER_CLIENT_SECRET"]);
  const diagnostics: string[] = [];
  if (!tenantId) {
    diagnostics.push(
      missingLiveConfigDiagnostic(options, legacyConfig, "DEFENDER_TENANT_ID"),
    );
  }
  if (!clientId) {
    diagnostics.push(
      missingLiveConfigDiagnostic(options, legacyConfig, "DEFENDER_CLIENT_ID"),
    );
  }
  if (!clientSecret) {
    diagnostics.push(
      missingLiveConfigDiagnostic(
        options,
        legacyConfig,
        "DEFENDER_CLIENT_SECRET",
      ),
    );
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return {
    ok: true,
    config: {
      DEFENDER_TENANT_ID: tenantId!,
      DEFENDER_CLIENT_ID: clientId!,
      ...(nonEmpty(source["DEFENDER_TIMEOUT_SECONDS"])
        ? {
            DEFENDER_TIMEOUT_SECONDS: nonEmpty(
              source["DEFENDER_TIMEOUT_SECONDS"],
            )!,
          }
        : {}),
    },
    secrets: { DEFENDER_CLIENT_SECRET: clientSecret! },
  };
}

function liveMdeConfigFromOptions(
  options: LiveParityRunnerOptions,
  legacyConfig: MCPServerConfig,
):
  | {
      ok: true;
      config: Record<string, string>;
      secrets: Record<string, string>;
    }
  | { ok: false; diagnostics: string[] } {
  const source = liveConfigSource(options, legacyConfig);
  const tenantId = nonEmpty(source["MDE_TENANT_ID"]);
  const clientId = nonEmpty(source["MDE_CLIENT_ID"]);
  const clientSecret = nonEmpty(source["MDE_CLIENT_SECRET"]);
  const diagnostics: string[] = [];
  if (!tenantId) {
    diagnostics.push(
      missingLiveConfigDiagnostic(options, legacyConfig, "MDE_TENANT_ID"),
    );
  }
  if (!clientId) {
    diagnostics.push(
      missingLiveConfigDiagnostic(options, legacyConfig, "MDE_CLIENT_ID"),
    );
  }
  if (!clientSecret) {
    diagnostics.push(
      missingLiveConfigDiagnostic(options, legacyConfig, "MDE_CLIENT_SECRET"),
    );
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return {
    ok: true,
    config: {
      MDE_TENANT_ID: tenantId!,
      MDE_CLIENT_ID: clientId!,
      ...(nonEmpty(source["MDE_TIMEOUT_SECONDS"])
        ? { MDE_TIMEOUT_SECONDS: nonEmpty(source["MDE_TIMEOUT_SECONDS"])! }
        : {}),
      ...(nonEmpty(source["MDE_MAX_PAGES"])
        ? { MDE_MAX_PAGES: nonEmpty(source["MDE_MAX_PAGES"])! }
        : { MDE_MAX_PAGES: "1" }),
    },
    secrets: { MDE_CLIENT_SECRET: clientSecret! },
  };
}

function liveMsGraphConfigFromOptions(
  options: LiveParityRunnerOptions,
  legacyConfig: MCPServerConfig,
):
  | {
      ok: true;
      config: Record<string, string>;
      secrets: Record<string, string>;
    }
  | { ok: false; diagnostics: string[] } {
  const source = liveConfigSource(options, legacyConfig);
  const tenantId = nonEmpty(source["MSGRAPH_TENANT_ID"]);
  const clientId = nonEmpty(source["MSGRAPH_CLIENT_ID"]);
  const clientSecret = nonEmpty(source["MSGRAPH_CLIENT_SECRET"]);
  const diagnostics: string[] = [];
  if (!tenantId) {
    diagnostics.push(
      missingLiveConfigDiagnostic(options, legacyConfig, "MSGRAPH_TENANT_ID"),
    );
  }
  if (!clientId) {
    diagnostics.push(
      missingLiveConfigDiagnostic(options, legacyConfig, "MSGRAPH_CLIENT_ID"),
    );
  }
  if (!clientSecret) {
    diagnostics.push(
      missingLiveConfigDiagnostic(
        options,
        legacyConfig,
        "MSGRAPH_CLIENT_SECRET",
      ),
    );
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return {
    ok: true,
    config: {
      MSGRAPH_TENANT_ID: tenantId!,
      MSGRAPH_CLIENT_ID: clientId!,
      ...(nonEmpty(source["MSGRAPH_TIMEOUT_SECONDS"])
        ? { MSGRAPH_TIMEOUT_SECONDS: nonEmpty(source["MSGRAPH_TIMEOUT_SECONDS"])! }
        : {}),
      ...(nonEmpty(source["MSGRAPH_MAX_PAGES"])
        ? { MSGRAPH_MAX_PAGES: nonEmpty(source["MSGRAPH_MAX_PAGES"])! }
        : { MSGRAPH_MAX_PAGES: "1" }),
      ...(nonEmpty(source["MSGRAPH_API_VERSION"])
        ? { MSGRAPH_API_VERSION: nonEmpty(source["MSGRAPH_API_VERSION"])! }
        : {}),
    },
    secrets: { MSGRAPH_CLIENT_SECRET: clientSecret! },
  };
}

function liveQualysConfigFromOptions(
  options: LiveParityRunnerOptions,
  legacyConfig: MCPServerConfig,
):
  | {
      ok: true;
      config: Record<string, string>;
      secrets: Record<string, string>;
    }
  | { ok: false; diagnostics: string[] } {
  const source = liveConfigSource(options, legacyConfig);
  const vmUrl = nonEmpty(source["QUALYS_VM_URL"]);
  const gatewayUrl = nonEmpty(source["QUALYS_GATEWAY_URL"]);
  const username = nonEmpty(source["QUALYS_USERNAME"]);
  const password = nonEmpty(source["QUALYS_PASSWORD"]);
  const diagnostics: string[] = [];
  if (!vmUrl) {
    diagnostics.push(
      missingLiveConfigDiagnostic(options, legacyConfig, "QUALYS_VM_URL"),
    );
  }
  if (!username) {
    diagnostics.push(
      missingLiveConfigDiagnostic(options, legacyConfig, "QUALYS_USERNAME"),
    );
  }
  if (!password) {
    diagnostics.push(
      missingLiveConfigDiagnostic(options, legacyConfig, "QUALYS_PASSWORD"),
    );
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return {
    ok: true,
    config: {
      QUALYS_VM_URL: vmUrl!,
      ...(gatewayUrl ? { QUALYS_GATEWAY_URL: gatewayUrl } : {}),
      QUALYS_VERIFY_TLS: nonEmpty(source["QUALYS_VERIFY_TLS"]) ?? "1",
      QUALYS_TIMEOUT_SECONDS:
        nonEmpty(source["QUALYS_TIMEOUT_SECONDS"]) ?? "120",
      QUALYS_ASSET_MAX_PAGES: "1",
      QUALYS_MAX_PAGES: "1",
    },
    secrets: {
      QUALYS_USERNAME: username!,
      QUALYS_PASSWORD: password!,
    },
  };
}

function liveSplunkConfigFromOptions(
  options: LiveParityRunnerOptions,
  legacyConfig: MCPServerConfig,
  now: Date,
):
  | {
      ok: true;
      config: Record<string, string>;
      secrets: Record<string, string>;
    }
  | { ok: false; diagnostics: string[] } {
  const source = liveConfigSource(options, legacyConfig);
  const tokenSource = liveConfigSourceValue(
    options,
    legacyConfig,
    "SPLUNK_TOKEN",
  );
  const baseUrl = nonEmpty(source["SPLUNK_BASE_URL"]);
  const token = nonEmpty(source["SPLUNK_TOKEN"]);
  const diagnostics: string[] = [];
  if (!baseUrl) {
    diagnostics.push(
      missingLiveConfigDiagnostic(options, legacyConfig, "SPLUNK_BASE_URL"),
    );
  }
  if (!token) {
    diagnostics.push(
      missingLiveConfigDiagnostic(options, legacyConfig, "SPLUNK_TOKEN"),
    );
  }
  const expiry = token ? jwtExpiration(token) : null;
  if (expiry && expiry.getTime() <= now.getTime()) {
    diagnostics.push(
      `SPLUNK_TOKEN expired at ${expiry.toISOString()} (${liveConfigSourceDiagnostic(
        tokenSource,
      )})`,
    );
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return {
    ok: true,
    config: { SPLUNK_BASE_URL: baseUrl! },
    secrets: { SPLUNK_TOKEN: token! },
  };
}

function jwtExpiration(raw: string): Date | null {
  const parts = raw.split(".");
  if (parts.length < 2) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }
    const exp = new Date(parsed.exp * 1000);
    return Number.isNaN(exp.getTime()) ? null : exp;
  } catch {
    return null;
  }
}

function liveConfigSource(
  options: LiveParityRunnerOptions,
  legacyConfig: MCPServerConfig,
): Record<string, unknown> {
  return {
    ...(legacyConfig.env ?? {}),
    ...(options.familyConfig ?? {}),
    ...(options.familySecrets ?? {}),
  };
}

function liveConfigSourceValue(
  options: LiveParityRunnerOptions,
  legacyConfig: MCPServerConfig,
  key: string,
): { configured: boolean; source: string | null } {
  let result: { configured: boolean; source: string | null } = {
    configured: false,
    source: null,
  };
  if (Object.hasOwn(legacyConfig.env ?? {}, key)) {
    result = { configured: true, source: "legacy MCP env" };
  }
  if (Object.hasOwn(options.familyConfig ?? {}, key)) {
    result = { configured: true, source: "runner config override" };
  }
  if (Object.hasOwn(options.familySecrets ?? {}, key)) {
    result = { configured: true, source: "runner secret override" };
  }
  return result;
}

function liveConfigSourceDiagnostic(input: {
  configured: boolean;
  source: string | null;
}): string {
  if (input.configured && input.source) return `source: ${input.source}`;
  return "checked legacy MCP env, runner config override, runner secret override";
}

function missingLiveConfigDiagnostic(
  options: LiveParityRunnerOptions,
  legacyConfig: MCPServerConfig,
  key: string,
): string {
  return `${key} is not configured (${liveConfigSourceDiagnostic(
    liveConfigSourceValue(options, legacyConfig, key),
  )})`;
}

export async function seedQualysHostedParityTarget(
  service: HostedIntegrationService,
  config: Record<string, string>,
  secrets: Record<string, string>,
): Promise<void> {
  return seedHostedParityTarget(service, "qualys", config, secrets);
}

export async function seedHostedParityTarget(
  service: HostedIntegrationService,
  familyId: string,
  config: Record<string, string>,
  secrets: Record<string, string>,
): Promise<void> {
  const fixture = parityFixtureForFamily(familyId);
  const lock = await service.locks.acquireLock({
    familyId: fixture.familyId,
    lockedBy: DEFAULT_ACTOR_ID,
    ttlMs: 60_000,
  });
  if (!lock.ok) {
    throw new Error(
      `qualys family is locked by ${lock.lock.lockedBy}; live parity cannot mutate hosted test target`,
    );
  }
  const created = await service.drafts.createDraftFromFiles({
    familyId: fixture.familyId,
    lockId: lock.lock.id,
    sourceRevisionId: `source_rev_live_parity_${Date.now()}`,
    files: fixture.sourceFiles,
  });
  if (!created.ok) throw new Error(created.reason);
  for (const example of fixture.examples) {
    await service.examples.upsertExample({
      draftId: created.draft.id,
      lockId: lock.lock.id,
      example,
    });
  }
  const validation = await service.validator.validateDraft(created.draft.id);
  if (!validation.ok) {
    throw new Error(
      `live parity hosted target validation failed: ${validation.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("; ")}`,
    );
  }
  const promoted = await service.generations.promoteDraft({
    draftId: created.draft.id,
    promotedBy: DEFAULT_ACTOR_ID,
    validation,
  });
  if (!promoted.ok) throw new Error(promoted.reason);
  await service.sourceFiles.replaceSourceFiles({
    familyId: fixture.familyId,
    files: fixture.sourceFiles,
    sourceRevisionId: created.draft.sourceRevisionId,
    updatedBy: DEFAULT_ACTOR_ID,
  });
  const environmentConfig =
    await service.environmentConfigs.upsertEnvironmentConfig({
      familyId: fixture.familyId,
      environment: DEFAULT_ENVIRONMENT,
      config,
      secrets: Object.fromEntries(
        Object.keys(secrets)
          .sort((a, b) => a.localeCompare(b))
          .map((name) => [name, { configured: true }]),
      ),
      updatedBy: "human:operator",
    });
  if (!environmentConfig.ok) throw new Error(environmentConfig.reason);
  await service.secrets.writeHumanOwnedSecrets({
    environmentConfigId: `${fixture.familyId}-${DEFAULT_ENVIRONMENT}`,
    secrets,
    updatedBy: "human:operator",
  });
  await service.locks.releaseLock({
    lockId: lock.lock.id,
    lockedBy: DEFAULT_ACTOR_ID,
  });
}

function parityFixtureForFamily(
  familyId: string,
): LegacyIntegrationHubReplacementFamilyFixture {
  if (familyId === "qualys") {
    return LEGACY_INTEGRATION_HUB_FIVE_READONLY_SOURCE_BACKED_FAMILY;
  }
  const fixture = LEGACY_INTEGRATION_HUB_REPLACEMENT_SECURITY_FAMILIES.find(
    (candidate) => candidate.familyId === familyId,
  );
  if (!fixture) {
    throw new Error(`live parity family '${familyId}' is not supported`);
  }
  return fixture;
}

async function runParityCase(
  hostedClient: HostedParityClient,
  legacyClient: LegacyMcpParityClient,
  testCase: LiveParityToolCase,
): Promise<LiveParityCaseResult> {
  const hosted = await callHostedTool(hostedClient, testCase);
  const legacy = await callLegacyTool(legacyClient, testCase);
  const comparison =
    hosted.ok && legacy.ok
      ? compareSanitizedResults(testCase, hosted, legacy)
      : "not_compared";
  const status =
    comparison === "match"
      ? "match"
      : hosted.ok && legacy.ok
        ? "mismatch"
        : "error";
  return {
    familyId: testCase.familyId,
    toolName: testCase.toolName,
    hostedToolName: testCase.hostedToolName,
    legacyMcpToolName: testCase.legacyMcpToolName,
    status,
    comparison,
    hosted,
    legacy,
    hostedRunId: hosted.runId,
    failureBucketId: hosted.failureBucketId,
  };
}

async function callHostedTool(
  hostedClient: HostedParityClient,
  testCase: LiveParityToolCase,
): Promise<SanitizedToolResult> {
  try {
    const result = await hostedClient.callTool(testCase);
    return sanitizeToolResult(result);
  } catch (error) {
    return sanitizeThrown(error);
  }
}

async function callLegacyTool(
  legacyClient: LegacyMcpParityClient,
  testCase: LiveParityToolCase,
): Promise<SanitizedToolResult> {
  try {
    const raw = await legacyClient.callTool(
      testCase.legacyServerName,
      bareLegacyToolName(testCase.legacyMcpToolName),
      testCase.legacyArgs ?? testCase.args,
    );
    return sanitizeToolResult(await resolveLegacyPayload(parseMaybeJson(raw)));
  } catch (error) {
    return sanitizeThrown(error);
  }
}

async function resolveLegacyPayload(value: unknown): Promise<unknown> {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const resultPath = stringFrom(record["result_path"]);
  if (!resultPath) return value;
  try {
    return parseMaybeJson(await readFile(resultPath, "utf-8"));
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "legacy_result_file_unavailable",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function compareSanitizedResults(
  testCase: LiveParityToolCase,
  hosted: SanitizedToolResult,
  legacy: SanitizedToolResult,
): "match" | "mismatch" {
  if (testCase.toolName.endsWith("_count")) {
    return hosted.summary["count"] === legacy.summary["count"]
      ? "match"
      : "mismatch";
  }
  if (
    testCase.toolName.endsWith("_search") ||
    testCase.toolName.endsWith("_list")
  ) {
    return hosted.summary["resultCount"] === legacy.summary["resultCount"]
      ? "match"
      : "mismatch";
  }
  return JSON.stringify(hosted.summary) === JSON.stringify(legacy.summary)
    ? "match"
    : "mismatch";
}

function sanitizeToolResult(value: unknown): SanitizedToolResult {
  const envelope = normalizeEnvelope(value);
  const summary = summarizePayload(envelope.payload);
  return {
    ok: envelope.ok,
    hash: hashJson(summary),
    summary,
    ...(envelope.runId ? { runId: envelope.runId } : {}),
    ...(envelope.failureBucketId
      ? { failureBucketId: envelope.failureBucketId }
      : {}),
    ...(envelope.error ? { error: envelope.error } : {}),
  };
}

function normalizeEnvelope(value: unknown): {
  ok: boolean;
  payload: unknown;
  runId?: string;
  failureBucketId?: string;
  error?: { code?: string; message: string };
} {
  if (typeof value === "string" && looksLikeErrorText(value)) {
    return {
      ok: false,
      payload: value,
      error: { message: value.slice(0, 300) },
    };
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const ok = record["ok"];
    if (typeof ok === "boolean") {
      const nested = normalizeNestedEnvelope(record);
      if (nested) {
        return {
          ...nested,
          runId: stringFrom(record["runId"]) ?? nested.runId,
          failureBucketId:
            stringFrom(record["failureBucketId"]) ?? nested.failureBucketId,
        };
      }
      const error = normalizeError(record["error"]);
      return {
        ok,
        payload: record["result"] ?? record["response"] ?? record,
        runId: stringFrom(record["runId"]),
        failureBucketId: stringFrom(record["failureBucketId"]),
        ...(error ? { error } : {}),
      };
    }
    const error = normalizeError(record["error"]);
    if (error) return { ok: false, payload: record, error };
  }
  return { ok: true, payload: value };
}

function summarizePayload(value: unknown): Record<string, unknown> {
  const payload = unwrapPayload(value);
  if (!payload || typeof payload !== "object") {
    return { scalarType: typeof payload };
  }
  const record = payload as Record<string, unknown>;
  const response = unwrapPayload(record["response"]);
  const responseRecord =
    response && typeof response === "object"
      ? (response as Record<string, unknown>)
      : undefined;
  const count = firstDefined(
    record["count"],
    responseRecord?.["count"],
    responseRecord?.["COUNT"],
  );
  const results = firstArray(record["results"], responseRecord?.["results"]);
  const resultCount = firstDefined(
    record["result_count"],
    record["resultCount"],
    responseRecord?.["result_count"],
    responseRecord?.["resultCount"],
    results?.length,
  );
  return stripUndefined({
    count: numericOrString(count),
    resultCount: numericOrString(resultCount),
    pagesFetched: numericOrString(record["pages_fetched"]),
    truncated: booleanOrUndefined(record["truncated"]),
    usedFilterBody: booleanOrUndefined(record["used_filter_body"]),
    usedFilterXml: booleanOrUndefined(record["used_filter_xml"]),
    nextCursorPresent: record["next_last_seen_asset_id"] != null,
    payloadKind: Array.isArray(payload) ? "array" : "object",
  });
}

function unwrapPayload(value: unknown): unknown {
  if (typeof value === "string") return parseMaybeJson(value);
  return value;
}

function parseMaybeJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
    if (fenced) {
      try {
        return JSON.parse(fenced.trim());
      } catch {
        // Fall through to object extraction.
      }
    }
    const firstObject = trimmed.indexOf("{");
    const lastObject = trimmed.lastIndexOf("}");
    if (firstObject >= 0 && lastObject > firstObject) {
      try {
        return JSON.parse(trimmed.slice(firstObject, lastObject + 1));
      } catch {
        // Keep the opaque string summary when this is not valid JSON.
      }
    }
    return trimmed;
  }
}

function normalizeNestedEnvelope(
  record: Record<string, unknown>,
): ReturnType<typeof normalizeEnvelope> | null {
  const envelope = record["envelope"];
  if (!envelope || typeof envelope !== "object") return null;
  const normalized = normalizeEnvelope(envelope);
  if (typeof record["ok"] === "boolean") {
    normalized.ok = record["ok"] && normalized.ok;
  }
  const topLevelError = normalizeError(record["error"]);
  if (topLevelError) normalized.error = normalized.error ?? topLevelError;
  return normalized;
}

function normalizeError(value: unknown):
  | {
      code?: string;
      message: string;
    }
  | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return { message: value.slice(0, 300) };
  if (typeof value !== "object") return { message: String(value).slice(0, 300) };
  const record = value as Record<string, unknown>;
  return {
    code: stringFrom(record["code"]),
    message:
      stringFrom(record["message"]) ??
      stringFrom(record["error"]) ??
      JSON.stringify(record).slice(0, 300),
  };
}

function sanitizeThrown(error: unknown): SanitizedToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    hash: hashJson({ error: message.slice(0, 300) }),
    summary: { payloadKind: "error" },
    error: { message: message.slice(0, 300) },
  };
}

async function writeEvidenceArtifact(
  dataDir: string,
  result: LiveParityRunResult,
): Promise<string> {
  const dir = path.join(dataDir, "hosted-integrations", "live-parity");
  await mkdir(dir, { recursive: true });
  const artifactPath = path.join(dir, `${result.runId}.json`);
  await writeFile(artifactPath, JSON.stringify(result, null, 2), "utf-8");
  return artifactPath;
}

function skipped(runId: string, diagnostics: string[]): LiveParityRunResult {
  return { status: "skipped", runId, diagnostics, cases: [] };
}

function bareLegacyToolName(legacyMcpToolName: string): string {
  const marker = "__";
  const markerIndex = legacyMcpToolName.indexOf(marker);
  return markerIndex >= 0
    ? legacyMcpToolName.slice(markerIndex + marker.length)
    : legacyMcpToolName;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numericOrString(value: unknown): string | number | undefined {
  return typeof value === "number" || typeof value === "string"
    ? value
    : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function firstArray(...values: unknown[]): unknown[] | undefined {
  return values.find(Array.isArray);
}

function stripUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function withoutKey(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const next = { ...value };
  delete next[key];
  return next;
}

function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

function looksLikeErrorText(value: string): boolean {
  return /^(input validation error|error|failed|traceback)\b/i.test(
    value.trim(),
  );
}

class DefaultLegacyMcpParityClient implements LegacyMcpParityClient {
  private readonly client = new MCPClient(new ToolRegistry());

  async connect(
    serverName: string,
    config: MCPServerConfig,
  ): Promise<{ ok: boolean; diagnostic?: string }> {
    const result = await this.client.connectServer(serverName, config, {
      skipOAuth: true,
    });
    return {
      ok: result.ok,
      diagnostic: result.ok
        ? undefined
        : `remote MCP server '${serverName}' ${result.state}: ${result.error ?? "unknown error"}`,
    };
  }

  callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    return this.client.callToolDirect(serverName, toolName, args);
  }

  close(): Promise<void> {
    return this.client.disconnect();
  }
}

class DefaultHostedParityClient implements HostedParityClient {
  constructor(
    private readonly service: HostedIntegrationService,
    private readonly familyId: string,
  ) {}

  prepare(
    config: Record<string, string>,
    secrets: Record<string, string>,
  ): Promise<void> {
    return seedHostedParityTarget(this.service, this.familyId, config, secrets);
  }

  callTool(testCase: LiveParityToolCase): Promise<unknown> {
    return this.service.gateway.invoke({
      actor: { id: DEFAULT_ACTOR_ID, kind: "agent", roles: ["agent"] },
      familyId: testCase.familyId,
      toolName: testCase.toolName,
      environment: DEFAULT_ENVIRONMENT,
      args: JsonObjectSchema.parse(
        testCase.hostedArgs ?? testCase.args,
      ) as JsonObject,
      hostedToolBindings: [
        liveParityHostedToolBinding(testCase),
      ],
    });
  }

  close(): Promise<void> {
    return this.service.close();
  }
}
