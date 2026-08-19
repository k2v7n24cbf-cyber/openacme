import { homedir } from "node:os";
import * as path from "node:path";
import {
  defaultLiveParityCasesForFamily,
  runHostedIntegrationLiveParity,
} from "../test-support/integration-hub/live-parity.js";

const dataDir =
  process.env["OPENACME_DATA_DIR"] ??
  path.join(homedir(), ".openamce-hosted-integrations-test-env");
const legacyMcpDataDir =
  process.env["OPENACME_LEGACY_MCP_DATA_DIR"] ?? dataDir;
const family = process.env["OPENACME_LIVE_PARITY_FAMILY"] ?? "qualys";
const selected = defaultLiveParityCasesForFamily(family);
const overrides = liveParityOverridesFromEnv(family, process.env);

if (!selected.ok) {
  console.log(
    JSON.stringify(
      {
        status: "skipped",
        runId: `live_parity_${family}`,
        diagnostics: [selected.diagnostic],
        cases: [],
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const result = await runHostedIntegrationLiveParity({
  dataDir,
  legacyMcpDataDir,
  cases: selected.cases,
  ...overrides,
});

console.log(JSON.stringify(result, null, 2));

process.exit(result.status === "fail" ? 1 : 0);

function liveParityOverridesFromEnv(
  familyId: string,
  env: NodeJS.ProcessEnv,
): {
  familyConfig?: Record<string, string>;
  familySecrets?: Record<string, string>;
} {
  const contracts: Record<
    string,
    { config: string[]; secrets: string[] }
  > = {
    qualys: {
      config: [
        "QUALYS_VM_URL",
        "QUALYS_GATEWAY_URL",
        "QUALYS_VERIFY_TLS",
        "QUALYS_TIMEOUT_SECONDS",
      ],
      secrets: ["QUALYS_USERNAME", "QUALYS_PASSWORD"],
    },
    splunk: {
      config: ["SPLUNK_BASE_URL"],
      secrets: ["SPLUNK_TOKEN"],
    },
    msgraph: {
      config: [
        "MSGRAPH_TENANT_ID",
        "MSGRAPH_CLIENT_ID",
        "MSGRAPH_TIMEOUT_SECONDS",
        "MSGRAPH_MAX_PAGES",
        "MSGRAPH_API_VERSION",
      ],
      secrets: ["MSGRAPH_CLIENT_SECRET"],
    },
    microsoft_defender: {
      config: [
        "MICROSOFT_DEFENDER_TENANT_ID",
        "MICROSOFT_DEFENDER_CLIENT_ID",
        "MICROSOFT_DEFENDER_TIMEOUT_SECONDS",
        "MICROSOFT_DEFENDER_MAX_PAGES",
      ],
      secrets: ["MICROSOFT_DEFENDER_CLIENT_SECRET"],
    },
  };
  const contract = contracts[familyId];
  if (!contract) return {};
  const familyConfig = readEnvKeys(env, contract.config);
  const familySecrets = readEnvKeys(env, contract.secrets);
  return {
    ...(Object.keys(familyConfig).length > 0 ? { familyConfig } : {}),
    ...(Object.keys(familySecrets).length > 0 ? { familySecrets } : {}),
  };
}

function readEnvKeys(
  env: NodeJS.ProcessEnv,
  keys: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) result[key] = value;
  }
  return result;
}
