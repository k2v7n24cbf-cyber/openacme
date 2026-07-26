import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { config as loadDotenv } from "dotenv";

type Env = Record<string, string | undefined>;

export interface DisabledLangfuseE2EConfig {
  enabled: false;
  reason: string;
  missing: string[];
  envFile: string;
}

export interface EnabledLangfuseE2EConfig {
  enabled: true;
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  envFile: string;
  dataDirRoot: string;
  keepDataDir: boolean;
  timeoutMs: number;
  pollMs: number;
}

export type LangfuseE2EConfig =
  | DisabledLangfuseE2EConfig
  | EnabledLangfuseE2EConfig;

export interface LangfuseObservation {
  id?: string;
  traceId?: string;
  trace_id?: string;
  name?: string;
  type?: string;
  startTime?: string;
  [key: string]: unknown;
}

export function loadLangfuseE2EEnv(env: Env = process.env): string {
  const envFile =
    env["OPENACME_E2E_ENV_FILE"] ??
    path.join(os.homedir(), ".openacme-test", ".env");
  if (existsSync(envFile)) {
    loadDotenv({ path: envFile, override: false });
  }
  return envFile;
}

export function resolveLangfuseE2EConfig(
  env: Env = process.env,
): LangfuseE2EConfig {
  const envFile =
    env["OPENACME_E2E_ENV_FILE"] ??
    path.join(os.homedir(), ".openacme-test", ".env");
  const liveRequested = truthy(env["OPENACME_E2E_LANGFUSE"]);
  const required = [
    "LANGFUSE_BASE_URL",
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
  ];
  const missing = [
    ...(liveRequested ? [] : ["OPENACME_E2E_LANGFUSE"]),
    ...required.filter((key) => !env[key]),
  ];
  if (missing.length > 0) {
    return {
      enabled: false,
      reason: `Langfuse live e2e disabled; missing ${missing.join(", ")}`,
      missing,
      envFile,
    };
  }

  const baseUrl = trimTrailingSlash(env["LANGFUSE_BASE_URL"]!);
  try {
    new URL(baseUrl);
  } catch {
    return {
      enabled: false,
      reason:
        "Langfuse live e2e disabled; LANGFUSE_BASE_URL is not a valid URL",
      missing: ["LANGFUSE_BASE_URL"],
      envFile,
    };
  }

  return {
    enabled: true,
    baseUrl,
    publicKey: env["LANGFUSE_PUBLIC_KEY"]!,
    secretKey: env["LANGFUSE_SECRET_KEY"]!,
    envFile,
    dataDirRoot:
      env["OPENACME_E2E_DATA_DIR"] ??
      path.join(os.homedir(), ".openacme-test", "langfuse-e2e"),
    keepDataDir: truthy(env["OPENACME_E2E_KEEP_DATA"]),
    timeoutMs: parsePositiveInt(
      env["OPENACME_E2E_LANGFUSE_TIMEOUT_MS"],
      120_000,
    ),
    pollMs: parsePositiveInt(env["OPENACME_E2E_LANGFUSE_POLL_MS"], 3_000),
  };
}

export async function fetchLangfuseObservations(
  config: EnabledLangfuseE2EConfig,
  query: {
    traceId?: string;
    sessionId?: string;
    fromStartTime?: Date;
    toStartTime?: Date;
  },
): Promise<LangfuseObservation[]> {
  try {
    return await requestLangfuseObservations(
      config,
      "/v2/observations",
      query,
      {
        fields: true,
      },
    );
  } catch (err) {
    if (!isV2UnavailableOnSelfHostedV3(err)) throw err;
    return requestLangfuseObservations(config, "/observations", query, {
      fields: false,
    });
  }
}

async function requestLangfuseObservations(
  config: EnabledLangfuseE2EConfig,
  publicPath: string,
  query: {
    traceId?: string;
    sessionId?: string;
    fromStartTime?: Date;
    toStartTime?: Date;
  },
  opts: { fields: boolean },
): Promise<LangfuseObservation[]> {
  const url = langfusePublicUrl(config.baseUrl, publicPath);
  url.searchParams.set("limit", "100");
  if (opts.fields) url.searchParams.set("fields", "core,basic,metadata,usage");
  if (query.traceId) url.searchParams.set("traceId", query.traceId);
  if (query.sessionId) url.searchParams.set("sessionId", query.sessionId);
  if (query.fromStartTime) {
    url.searchParams.set("fromStartTime", query.fromStartTime.toISOString());
  }
  if (query.toStartTime) {
    url.searchParams.set("toStartTime", query.toStartTime.toISOString());
  }

  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: basicAuth(config.publicKey, config.secretKey),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(
      `Langfuse observations request failed (${res.status} ${res.statusText}): ${truncate(body, 800)}`,
    );
  }
  return normalizeObservations(parseJson(body));
}

function isV2UnavailableOnSelfHostedV3(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes("404 Not Found") &&
    err.message.includes("v4 write mode")
  );
}

export async function pollLangfuseObservations(
  config: EnabledLangfuseE2EConfig,
  query: {
    traceId: string;
    sessionId: string;
    fromStartTime: Date;
    expectedNames: string[];
  },
): Promise<LangfuseObservation[]> {
  const deadline = Date.now() + config.timeoutMs;
  let lastError: string | undefined;
  let lastNames: string[] = [];

  while (Date.now() <= deadline) {
    try {
      const observations = await fetchLangfuseObservations(config, {
        traceId: query.traceId,
        sessionId: query.sessionId,
        fromStartTime: query.fromStartTime,
        toStartTime: new Date(Date.now() + 60_000),
      });
      lastNames = observationNames(observations);
      if (query.expectedNames.every((name) => lastNames.includes(name))) {
        return observations;
      }
      lastError = undefined;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(config.pollMs);
  }

  throw new Error(
    [
      `Timed out waiting for Langfuse observations after ${config.timeoutMs}ms`,
      `traceId=${query.traceId}`,
      `sessionId=${query.sessionId}`,
      `expected=${query.expectedNames.join(",")}`,
      `lastNames=${lastNames.join(",") || "<none>"}`,
      lastError ? `lastError=${lastError}` : undefined,
    ]
      .filter(Boolean)
      .join(" | "),
  );
}

export function observationNames(
  observations: LangfuseObservation[],
): string[] {
  return [
    ...new Set(
      observations
        .map((obs) => (typeof obs.name === "string" ? obs.name : undefined))
        .filter((name): name is string => Boolean(name)),
    ),
  ].sort();
}

function langfusePublicUrl(baseUrl: string, publicPath: string): URL {
  const base = trimTrailingSlash(baseUrl);
  const suffix = base.endsWith("/api/public")
    ? publicPath
    : `/api/public${publicPath}`;
  return new URL(`${base}${suffix}`);
}

function basicAuth(publicKey: string, secretKey: string): string {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
}

function normalizeObservations(body: unknown): LangfuseObservation[] {
  if (Array.isArray(body)) return body.filter(isObservation);
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: unknown }).data;
  if (Array.isArray(data)) return data.filter(isObservation);
  const observations = (body as { observations?: unknown }).observations;
  if (Array.isArray(observations)) return observations.filter(isObservation);
  return [];
}

function isObservation(value: unknown): value is LangfuseObservation {
  return !!value && typeof value === "object";
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function truthy(value: string | undefined): boolean {
  return !!value && ["1", "true", "yes"].includes(value.trim().toLowerCase());
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
