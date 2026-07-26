export type ObservabilityBackend = "off" | "logfire" | "langfuse" | "otlp";

export interface DisabledObservabilityConfig {
  enabled: false;
  backend: ObservabilityBackend;
  serviceName: string;
  reason?: string;
}

export interface EnabledObservabilityConfig {
  enabled: true;
  backend: Exclude<ObservabilityBackend, "off">;
  serviceName: string;
  tracesEndpoint: string;
  logsEndpoint?: string;
  headers: Record<string, string>;
}

export type ObservabilityConfig =
  | DisabledObservabilityConfig
  | EnabledObservabilityConfig;

type Env = Record<string, string | undefined>;

const TRUE_VALUES = new Set(["1", "true", "yes"]);

export function resolveObservabilityConfig(
  env: Env = process.env
): ObservabilityConfig {
  const serviceName = env["OPENACME_TELEMETRY_SERVICE_NAME"] ?? "openacme";
  const requested = normalizeBackend(env["OPENACME_OBSERVABILITY"]);
  const telemetryFlag = env["OPENACME_TELEMETRY"];
  const legacyEnabled =
    telemetryFlag !== undefined &&
    TRUE_VALUES.has(telemetryFlag.trim().toLowerCase());

  const backend = requested ?? (legacyEnabled ? "logfire" : "off");
  if (backend === "off") {
    return { enabled: false, backend: "off", serviceName };
  }

  if (backend === "logfire") {
    const token = env["LOGFIRE_TOKEN"];
    if (!token) {
      return {
        enabled: false,
        backend,
        serviceName,
        reason: "LOGFIRE_TOKEN is required for Logfire observability",
      };
    }
    return {
      enabled: true,
      backend,
      serviceName,
      tracesEndpoint:
        env["LOGFIRE_ENDPOINT"] ?? "https://api-us.pydantic.dev/v1/traces",
      logsEndpoint:
        env["LOGFIRE_LOGS_ENDPOINT"] ?? "https://api-us.pydantic.dev/v1/logs",
      headers: { Authorization: `Bearer ${token}` },
    };
  }

  if (backend === "langfuse") {
    const baseUrl = env["LANGFUSE_BASE_URL"];
    const publicKey = env["LANGFUSE_PUBLIC_KEY"];
    const secretKey = env["LANGFUSE_SECRET_KEY"];
    const missing = [
      ["LANGFUSE_BASE_URL", baseUrl],
      ["LANGFUSE_PUBLIC_KEY", publicKey],
      ["LANGFUSE_SECRET_KEY", secretKey],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      return {
        enabled: false,
        backend,
        serviceName,
        reason: `${missing.join(", ")} required for Langfuse observability`,
      };
    }
    const endpointBase = `${trimTrailingSlash(baseUrl!)}/api/public/otel`;
    return {
      enabled: true,
      backend,
      serviceName,
      tracesEndpoint: `${endpointBase}/v1/traces`,
      headers: {
        Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
        "x-langfuse-ingestion-version": "4",
      },
    };
  }

  const tracesEndpoint = env["OPENACME_OTLP_TRACES_ENDPOINT"];
  if (!tracesEndpoint) {
    return {
      enabled: false,
      backend,
      serviceName,
      reason: "OPENACME_OTLP_TRACES_ENDPOINT is required for OTLP observability",
    };
  }
  return {
    enabled: true,
    backend,
    serviceName,
    tracesEndpoint,
    logsEndpoint: env["OPENACME_OTLP_LOGS_ENDPOINT"],
    headers: parseOtlpHeaders(env["OPENACME_OTLP_HEADERS"]),
  };
}

export function parseOtlpHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const headers: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).trim();
    const val = entry.slice(eq + 1).trim();
    if (!key) continue;
    headers[key] = val;
  }
  return headers;
}

function normalizeBackend(value: string | undefined): ObservabilityBackend | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "logfire" ||
    normalized === "langfuse" ||
    normalized === "otlp"
  ) {
    return normalized;
  }
  return "off";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
