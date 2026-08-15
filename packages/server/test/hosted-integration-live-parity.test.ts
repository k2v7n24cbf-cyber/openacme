import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveGlobalMcpServers } from "@openacme/config";
import { createFileHostedIntegrationService } from "@openacme/hosted-integrations";
import {
  defaultLiveParityCasesForFamily,
  defaultSplunkLiveParityCases,
  liveParityHostedToolBinding,
  runHostedIntegrationLiveParity,
  seedManagedParityTarget,
  seedQualysManagedParityTarget,
  type LegacyMcpParityClient,
  type LiveParityToolCase,
  type ManagedHostedParityClient,
} from "../test-support/integration-hub/live-parity.js";

const testCase: LiveParityToolCase = {
  familyId: "qualys",
  toolName: "qualys_gav_asset_count",
  managedHostedToolName: "managed_qualys__qualys_gav_asset_count",
  legacyServerName: "integration-hub",
  legacyMcpToolName: "mcp_integration-hub__qualys_gav_asset_count",
  args: {
    filter_body: {
      filters: [
        {
          field: "operatingSystem.category1",
          operator: "EQUALS",
          value: "Server",
        },
      ],
    },
  },
};

const splunkTestCase: LiveParityToolCase = {
  familyId: "splunk",
  toolName: "splunk_search",
  managedHostedToolName: "managed_splunk__splunk_search",
  legacyServerName: "integration-hub",
  legacyMcpToolName: "mcp_integration-hub__splunk_search",
  args: { query: 'index=main "login"', limit: 2 },
  legacyArgs: { query: 'index=main "login"' },
};

const msgraphTestCase: LiveParityToolCase = {
  familyId: "msgraph",
  toolName: "msgraph_get",
  managedHostedToolName: "managed_msgraph__msgraph_get",
  legacyServerName: "integration-hub",
  legacyMcpToolName: "mcp_integration-hub__msgraph_get",
  args: { path: "/" },
};

const mdeTestCase: LiveParityToolCase = {
  familyId: "mde",
  toolName: "mde_get",
  managedHostedToolName: "managed_mde__mde_get",
  legacyServerName: "integration-hub",
  legacyMcpToolName: "mcp_integration-hub__mde_get",
  args: { path: "/machines", params: { "$top": "1" } },
};

const defenderAlertTestCase: LiveParityToolCase = {
  familyId: "defender-alert",
  toolName: "defender_alert_get",
  managedHostedToolName: "managed_defender-alert__defender_alert_get",
  legacyServerName: "integration-hub",
  legacyMcpToolName: "mcp_integration-hub__defender_alert_get",
  args: { graph_alert_id: "sample-alert-id" },
};

let dataDirs: string[] = [];

afterEach(() => {
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
});

describe("hosted integration live parity runner", () => {
  it("builds default Splunk live parity cases from the replacement fixture", () => {
    expect(defaultSplunkLiveParityCases()).toEqual([splunkTestCase]);
  });

  it("selects only source-backed live parity families", () => {
    expect(defaultLiveParityCasesForFamily("qualys")).toMatchObject({
      ok: true,
      cases: expect.arrayContaining([
        expect.objectContaining({ familyId: "qualys" }),
      ]),
    });
    expect(defaultLiveParityCasesForFamily("splunk")).toEqual({
      ok: true,
      cases: [splunkTestCase],
    });
    expect(defaultLiveParityCasesForFamily("msgraph")).toEqual({
      ok: true,
      cases: [msgraphTestCase],
    });
    expect(defaultLiveParityCasesForFamily("mde")).toEqual({
      ok: true,
      cases: [mdeTestCase],
    });
    expect(defaultLiveParityCasesForFamily("defender-alert")).toEqual({
      ok: true,
      cases: [defenderAlertTestCase],
    });
    expect(defaultLiveParityCasesForFamily("not-source-backed")).toEqual({
      ok: false,
      diagnostic:
        "live parity family 'not-source-backed' is not source-backed yet; supported families: qualys, splunk, msgraph, mde, defender-alert",
    });
  });

  it("skips with explicit diagnostics when remote MCP config is absent", async () => {
    const dataDir = tempDir();

    const result = await runHostedIntegrationLiveParity({
      dataDir,
      cases: [testCase],
      managedClient: fakeManagedClient(),
      legacyClient: fakeLegacyClient(),
      createId: () => "live_parity_skip_mcp",
    });

    expect(result).toMatchObject({
      status: "skipped",
      runId: "live_parity_skip_mcp",
      cases: [],
    });
    expect(result.diagnostics[0]).toContain(
      "remote MCP server 'integration-hub' is not configured",
    );
  });

  it("skips with explicit diagnostics when Qualys credentials are absent", async () => {
    const dataDir = tempDir();
    saveGlobalMcpServers(dataDir, {
      "integration-hub": {
        command: "node",
        args: ["server.js"],
        env: { QUALYS_VM_URL: "https://qualys.example.test" },
      },
    });

    const result = await runHostedIntegrationLiveParity({
      dataDir,
      cases: [testCase],
      managedClient: fakeManagedClient(),
      legacyClient: fakeLegacyClient(),
      createId: () => "live_parity_skip_creds",
    });

    expect(result.status).toBe("skipped");
    expect(result.diagnostics).toEqual([
      "QUALYS_USERNAME is not configured (checked legacy MCP env, runner config override, runner secret override)",
      "QUALYS_PASSWORD is not configured (checked legacy MCP env, runner config override, runner secret override)",
    ]);
  });

  it("skips with explicit diagnostics when Splunk runtime config is absent", async () => {
    const dataDir = tempDir();
    saveGlobalMcpServers(dataDir, {
      "integration-hub": {
        command: "node",
        args: ["server.js"],
        env: { SPLUNK_BASE_URL: "https://splunk.example.test" },
      },
    });

    const result = await runHostedIntegrationLiveParity({
      dataDir,
      cases: [splunkTestCase],
      managedClient: fakeManagedClient(),
      legacyClient: fakeLegacyClient(),
      createId: () => "live_parity_skip_splunk_creds",
    });

    expect(result.status).toBe("skipped");
    expect(result.diagnostics).toEqual([
      "SPLUNK_TOKEN is not configured (checked legacy MCP env, runner config override, runner secret override)",
    ]);
  });

  it("skips before target calls when a Splunk JWT token is expired", async () => {
    const dataDir = tempDir();
    const managed = fakeManagedClient();
    const legacy = fakeLegacyClient();
    saveGlobalMcpServers(dataDir, {
      "integration-hub": {
        command: "node",
        args: ["server.js"],
        env: {
          SPLUNK_BASE_URL: "https://splunk.example.test",
          SPLUNK_TOKEN: jwtWithExpiration("2026-08-14T14:57:55.000Z"),
        },
      },
    });

    const result = await runHostedIntegrationLiveParity({
      dataDir,
      cases: [splunkTestCase],
      managedClient: managed,
      legacyClient: legacy,
      now: () => new Date("2026-08-14T16:29:06.000Z"),
      createId: () => "live_parity_skip_splunk_expired",
    });

    expect(result).toMatchObject({
      status: "skipped",
      cases: [],
      diagnostics: [
        "SPLUNK_TOKEN expired at 2026-08-14T14:57:55.000Z (source: legacy MCP env)",
      ],
    });
    expect(managed.prepared).toEqual([]);
    expect(legacy.calls).toEqual([]);
  });

  it("lets explicit Splunk runner overrides replace expired legacy MCP env credentials", async () => {
    const dataDir = tempDir();
    saveGlobalMcpServers(dataDir, {
      "integration-hub": {
        command: "node",
        args: ["server.js"],
        env: {
          SPLUNK_BASE_URL: "https://expired-splunk.example.test",
          SPLUNK_TOKEN: jwtWithExpiration("2026-08-14T14:57:55.000Z"),
        },
      },
    });
    const managed = fakeManagedClient({
      ok: true,
      result: { result_count: 1, results: [{ id: 1 }] },
      runId: "hosted_splunk_override_run_1",
    });
    const legacy = fakeLegacyClient(
      JSON.stringify({ result_count: 1, results: [{ id: 1 }] }),
    );

    const result = await runHostedIntegrationLiveParity({
      dataDir,
      cases: [splunkTestCase],
      managedClient: managed,
      legacyClient: legacy,
      familyConfig: {
        SPLUNK_BASE_URL: "https://override-splunk.example.test",
      },
      familySecrets: { SPLUNK_TOKEN: "fresh-runner-token" },
      now: () => new Date("2026-08-14T16:29:06.000Z"),
      createId: () => "live_parity_splunk_override_pass",
    });

    expect(result.status).toBe("pass");
    expect(result.diagnostics).toEqual([]);
    expect(managed.prepared).toEqual([
      {
        config: { SPLUNK_BASE_URL: "https://override-splunk.example.test" },
        secrets: { SPLUNK_TOKEN: "fresh-runner-token" },
      },
    ]);
  });

  it("skips with explicit diagnostics when Microsoft Graph runtime config is absent", async () => {
    const dataDir = tempDir();
    saveGlobalMcpServers(dataDir, {
      "integration-hub": {
        command: "node",
        args: ["server.js"],
        env: { MSGRAPH_TENANT_ID: "tenant-id" },
      },
    });

    const result = await runHostedIntegrationLiveParity({
      dataDir,
      cases: [msgraphTestCase],
      managedClient: fakeManagedClient(),
      legacyClient: fakeLegacyClient(),
      createId: () => "live_parity_skip_msgraph_creds",
    });

    expect(result.status).toBe("skipped");
    expect(result.diagnostics).toEqual([
      "MSGRAPH_CLIENT_ID is not configured (checked legacy MCP env, runner config override, runner secret override)",
      "MSGRAPH_CLIENT_SECRET is not configured (checked legacy MCP env, runner config override, runner secret override)",
    ]);
  });

  it("skips with explicit diagnostics when MDE runtime config is absent", async () => {
    const dataDir = tempDir();
    saveGlobalMcpServers(dataDir, {
      "integration-hub": {
        command: "node",
        args: ["server.js"],
        env: {
          MDE_TENANT_ID: "tenant-id",
          MSGRAPH_CLIENT_ID: "graph-client-id",
          MSGRAPH_CLIENT_SECRET: "graph-client-secret",
        },
      },
    });

    const result = await runHostedIntegrationLiveParity({
      dataDir,
      cases: [mdeTestCase],
      managedClient: fakeManagedClient(),
      legacyClient: fakeLegacyClient(),
      createId: () => "live_parity_skip_mde_creds",
    });

    expect(result.status).toBe("skipped");
    expect(result.diagnostics).toEqual([
      "MDE_CLIENT_ID is not configured (checked legacy MCP env, runner config override, runner secret override)",
      "MDE_CLIENT_SECRET is not configured (checked legacy MCP env, runner config override, runner secret override)",
    ]);
  });

  it("skips with explicit diagnostics when Defender Alert runtime config is absent", async () => {
    const dataDir = tempDir();
    saveGlobalMcpServers(dataDir, {
      "integration-hub": {
        command: "node",
        args: ["server.js"],
        env: {
          DEFENDER_TENANT_ID: "tenant-id",
          MSGRAPH_CLIENT_ID: "graph-client-id",
          MDE_CLIENT_ID: "mde-client-id",
        },
      },
    });

    const result = await runHostedIntegrationLiveParity({
      dataDir,
      cases: [defenderAlertTestCase],
      managedClient: fakeManagedClient(),
      legacyClient: fakeLegacyClient(),
      createId: () => "live_parity_skip_defender_alert_creds",
    });

    expect(result.status).toBe("skipped");
    expect(result.diagnostics).toEqual([
      "DEFENDER_CLIENT_ID is not configured (checked legacy MCP env, runner config override, runner secret override)",
      "DEFENDER_CLIENT_SECRET is not configured (checked legacy MCP env, runner config override, runner secret override)",
    ]);
  });

  it("runs Splunk parity with sanitized result-count comparison", async () => {
    const dataDir = tempDir();
    saveGlobalMcpServers(dataDir, {
      "integration-hub": {
        command: "node",
        args: ["server.js"],
        env: {
          SPLUNK_BASE_URL: "https://splunk.example.test",
          SPLUNK_TOKEN: "raw-splunk-token",
        },
      },
    });
    const managed = fakeManagedClient({
      ok: true,
      result: { result_count: 2, results: [{ id: 1 }, { id: 2 }] },
      runId: "hosted_splunk_run_1",
    });
    const legacy = fakeLegacyClient(
      JSON.stringify({
        result_count: 2,
        results: [{ event: "sensitive-event" }, { event: "other" }],
      }),
    );

    const result = await runHostedIntegrationLiveParity({
      dataDir,
      cases: [splunkTestCase],
      managedClient: managed,
      legacyClient: legacy,
      createId: () => "live_parity_splunk_pass",
    });

    expect(result.status).toBe("pass");
    expect(managed.prepared).toEqual([
      {
        config: { SPLUNK_BASE_URL: "https://splunk.example.test" },
        secrets: { SPLUNK_TOKEN: "raw-splunk-token" },
      },
    ]);
    expect(legacy.calls).toEqual([
      {
        serverName: "integration-hub",
        toolName: "splunk_search",
        args: splunkTestCase.legacyArgs!,
      },
    ]);
    expect(result.cases[0]).toMatchObject({
      familyId: "splunk",
      status: "match",
      comparison: "match",
      hostedRunId: "hosted_splunk_run_1",
      managed: { summary: { resultCount: 2, payloadKind: "object" } },
      legacy: { summary: { resultCount: 2, payloadKind: "object" } },
    });
    const artifact = readFileSync(result.artifactPath!, "utf-8");
    expect(artifact).not.toContain("raw-splunk-token");
    expect(artifact).not.toContain("sensitive-event");
  });


  it("invokes legacy MCP and managed hosted tools, then writes sanitized evidence", async () => {
    const dataDir = tempDir();
    saveGlobalMcpServers(dataDir, {
      "integration-hub": {
        command: "node",
        args: ["server.js"],
        env: {
          QUALYS_VM_URL: "https://qualys.example.test",
          QUALYS_USERNAME: "api-user",
          QUALYS_PASSWORD: "raw-secret-password",
        },
      },
    });
    const managed = fakeManagedClient({
      ok: true,
      result: { count: 7, used_filter_body: true },
      runId: "hosted_run_1",
    });
    const legacy = fakeLegacyClient(
      JSON.stringify({ count: 7, used_filter_body: true }),
    );

    const result = await runHostedIntegrationLiveParity({
      dataDir,
      cases: [testCase],
      managedClient: managed,
      legacyClient: legacy,
      createId: () => "live_parity_pass",
    });

    expect(result.status).toBe("pass");
    expect(managed.prepared).toEqual([
      {
        config: expect.objectContaining({
          QUALYS_VM_URL: "https://qualys.example.test",
        }),
        secrets: {
          QUALYS_USERNAME: "api-user",
          QUALYS_PASSWORD: "raw-secret-password",
        },
      },
    ]);
    expect(legacy.calls).toEqual([
      {
        serverName: "integration-hub",
        toolName: "qualys_gav_asset_count",
        args: testCase.args,
      },
    ]);
    expect(result.cases[0]).toMatchObject({
      status: "match",
      comparison: "match",
      hostedRunId: "hosted_run_1",
      managed: {
        ok: true,
        summary: { count: 7, usedFilterBody: true, payloadKind: "object" },
      },
      legacy: {
        ok: true,
        summary: { count: 7, usedFilterBody: true, payloadKind: "object" },
      },
    });
    expect(result.artifactPath).toBeTruthy();
    const artifact = readFileSync(result.artifactPath!, "utf-8");
    expect(artifact).toContain("live_parity_pass");
    expect(artifact).not.toContain("raw-secret-password");
  });

  it("compares count parity semantically while retaining implementation metadata", async () => {
    const dataDir = tempDir();
    saveGlobalMcpServers(dataDir, {
      "integration-hub": {
        command: "node",
        args: ["server.js"],
        env: {
          QUALYS_VM_URL: "https://qualys.example.test",
          QUALYS_USERNAME: "api-user",
          QUALYS_PASSWORD: "raw-secret-password",
        },
      },
    });

    const result = await runHostedIntegrationLiveParity({
      dataDir,
      cases: [testCase],
      managedClient: fakeManagedClient({
        ok: true,
        result: { count: 42, used_filter_body: true },
      }),
      legacyClient: fakeLegacyClient(
        JSON.stringify({
          count: 42,
          pages_fetched: 1,
          truncated: false,
        }),
      ),
      createId: () => "live_parity_semantic_count",
      writeEvidence: false,
    });

    expect(result.status).toBe("pass");
    expect(result.cases[0]).toMatchObject({
      status: "match",
      comparison: "match",
      managed: { summary: { count: 42, usedFilterBody: true } },
      legacy: { summary: { count: 42, pagesFetched: 1, truncated: false } },
    });
  });

  it("summarizes legacy result_path artifacts without embedding raw records", async () => {
    const dataDir = tempDir();
    const legacyArtifactPath = path.join(dataDir, "legacy-result.json");
    writeFileSync(
      legacyArtifactPath,
      JSON.stringify({
        count: 2,
        results: [{ assetName: "sensitive-hostname" }, { assetName: "other" }],
      }),
      "utf-8",
    );
    saveGlobalMcpServers(dataDir, {
      "integration-hub": {
        command: "node",
        args: ["server.js"],
        env: {
          QUALYS_VM_URL: "https://qualys.example.test",
          QUALYS_USERNAME: "api-user",
          QUALYS_PASSWORD: "raw-secret-password",
        },
      },
    });

    const result = await runHostedIntegrationLiveParity({
      dataDir,
      cases: [testCase],
      managedClient: fakeManagedClient({
        ok: true,
        result: { count: 2, results: [{ id: 1 }, { id: 2 }] },
      }),
      legacyClient: fakeLegacyClient(
        JSON.stringify({ ok: true, result_path: legacyArtifactPath }),
      ),
      createId: () => "live_parity_result_path",
    });

    expect(result.status).toBe("pass");
    expect(result.cases[0]?.legacy.summary).toMatchObject({
      count: 2,
      resultCount: 2,
    });
    const artifact = readFileSync(result.artifactPath!, "utf-8");
    expect(artifact).not.toContain("sensitive-hostname");
  });

  it("uses an internal hosted-tool binding for live parity calls", () => {
    expect(
      liveParityHostedToolBinding(testCase, () => new Date("2026-08-14T00:00:00.000Z")),
    ).toEqual({
      agentId: "agent:live-parity-runner",
      familyId: "qualys",
      toolName: "qualys_gav_asset_count",
      allowedEnvironments: ["test_debug"],
      defaultEnvironment: "test_debug",
      generationPin: { type: "current" },
      bindingKind: "internal",
      purpose: "live-parity",
      updatedAt: "2026-08-14T00:00:00.000Z",
      updatedBy: "agent:live-parity-runner",
    });
  });

  it("seeds only the canonical test_debug environment config for live parity", async () => {
    const dataDir = tempDir();
    const service = createFileHostedIntegrationService({ dataDir });
    try {
      await seedQualysManagedParityTarget(
        service,
        { QUALYS_VM_URL: "https://qualys.example.test" },
        {
          QUALYS_USERNAME: "api-user",
          QUALYS_PASSWORD: "raw-secret-password",
        },
      );

      const configs = await service.environmentConfigs.listEnvironmentConfigs();
      expect(configs.map((config) => config.id)).toEqual(["qualys-test_debug"]);
      expect(configs[0]).toMatchObject({
        familyId: "qualys",
        environment: "test_debug",
        config: { QUALYS_VM_URL: "https://qualys.example.test" },
        secrets: {
          QUALYS_USERNAME: { configured: true },
          QUALYS_PASSWORD: { configured: true },
        },
      });
      expect(JSON.stringify(configs)).not.toContain("raw-secret-password");
      expect(JSON.stringify(configs)).not.toContain("qualys-live-parity");
      expect(JSON.stringify(configs)).not.toContain("qualys-live-demo");
    } finally {
      await service.close();
    }
  });

  it("seeds only the canonical Splunk test_debug environment config for live parity", async () => {
    const dataDir = tempDir();
    const service = createFileHostedIntegrationService({ dataDir });
    try {
      await seedManagedParityTarget(
        service,
        "splunk",
        { SPLUNK_BASE_URL: "https://splunk.example.test" },
        { SPLUNK_TOKEN: "raw-splunk-token" },
      );

      const configs = await service.environmentConfigs.listEnvironmentConfigs();
      expect(configs.map((config) => config.id)).toEqual(["splunk-test_debug"]);
      expect(configs[0]).toMatchObject({
        familyId: "splunk",
        environment: "test_debug",
        config: { SPLUNK_BASE_URL: "https://splunk.example.test" },
        secrets: { SPLUNK_TOKEN: { configured: true } },
      });
      expect(JSON.stringify(configs)).not.toContain("raw-splunk-token");
    } finally {
      await service.close();
    }
  });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openacme-live-parity-"));
  dataDirs.push(dir);
  return dir;
}

function fakeManagedClient(result: unknown = { ok: true, result: {} }) {
  const prepared: Array<{
    config: Record<string, string>;
    secrets: Record<string, string>;
  }> = [];
  return {
    prepared,
    async prepare(config, secrets) {
      prepared.push({ config, secrets });
    },
    async callTool() {
      return result;
    },
    async close() {},
  } satisfies ManagedHostedParityClient & {
    prepared: typeof prepared;
  };
}

function fakeLegacyClient(result = "{}") {
  const calls: Array<{
    serverName: string;
    toolName: string;
    args: Record<string, unknown>;
  }> = [];
  return {
    calls,
    async connect() {
      return { ok: true };
    },
    async callTool(serverName, toolName, args) {
      calls.push({ serverName, toolName, args });
      return result;
    },
    async close() {},
  } satisfies LegacyMcpParityClient & {
    calls: typeof calls;
  };
}

function jwtWithExpiration(iso: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS512", typ: "static" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(new Date(iso).getTime() / 1000) }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}
