import { describe, expect, it } from "vitest";
import {
  resolveObservabilityConfig,
  parseOtlpHeaders,
} from "../src/observability-config.js";

describe("resolveObservabilityConfig", () => {
  it("is disabled when telemetry and observability env are absent", () => {
    expect(resolveObservabilityConfig({})).toEqual({
      enabled: false,
      backend: "off",
      serviceName: "openacme",
    });
  });

  it("preserves legacy Logfire behavior behind OPENACME_TELEMETRY", () => {
    expect(
      resolveObservabilityConfig({
        OPENACME_TELEMETRY: "1",
        LOGFIRE_TOKEN: "lf-token",
      })
    ).toMatchObject({
      enabled: true,
      backend: "logfire",
      tracesEndpoint: "https://api-us.pydantic.dev/v1/traces",
      logsEndpoint: "https://api-us.pydantic.dev/v1/logs",
      headers: { Authorization: "Bearer lf-token" },
    });
  });

  it("uses explicit Logfire endpoints when provided", () => {
    expect(
      resolveObservabilityConfig({
        OPENACME_OBSERVABILITY: "logfire",
        LOGFIRE_TOKEN: "lf-token",
        LOGFIRE_ENDPOINT: "https://logfire.example/traces",
        LOGFIRE_LOGS_ENDPOINT: "https://logfire.example/logs",
      })
    ).toMatchObject({
      enabled: true,
      backend: "logfire",
      tracesEndpoint: "https://logfire.example/traces",
      logsEndpoint: "https://logfire.example/logs",
    });
  });

  it("resolves Langfuse OTLP endpoint and auth headers", () => {
    expect(
      resolveObservabilityConfig({
        OPENACME_OBSERVABILITY: "langfuse",
        LANGFUSE_BASE_URL: "http://localhost:3000/",
        LANGFUSE_PUBLIC_KEY: "pk-test",
        LANGFUSE_SECRET_KEY: "sk-test",
      })
    ).toEqual({
      enabled: true,
      backend: "langfuse",
      serviceName: "openacme",
      tracesEndpoint: "http://localhost:3000/api/public/otel/v1/traces",
      logsEndpoint: undefined,
      headers: {
        Authorization: `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`,
        "x-langfuse-ingestion-version": "4",
      },
    });
  });

  it("rejects incomplete Langfuse config", () => {
    expect(
      resolveObservabilityConfig({
        OPENACME_OBSERVABILITY: "langfuse",
        LANGFUSE_BASE_URL: "http://localhost:3000",
        LANGFUSE_PUBLIC_KEY: "pk-test",
      })
    ).toMatchObject({
      enabled: false,
      backend: "langfuse",
      reason: expect.stringContaining("LANGFUSE_SECRET_KEY"),
    });
  });

  it("resolves generic OTLP endpoints and headers", () => {
    expect(
      resolveObservabilityConfig({
        OPENACME_OBSERVABILITY: "otlp",
        OPENACME_OTLP_TRACES_ENDPOINT: "http://collector:4318/v1/traces",
        OPENACME_OTLP_LOGS_ENDPOINT: "http://collector:4318/v1/logs",
        OPENACME_OTLP_HEADERS: "x-api-key=abc,tenant = acme",
        OPENACME_TELEMETRY_SERVICE_NAME: "openacme-test",
      })
    ).toEqual({
      enabled: true,
      backend: "otlp",
      serviceName: "openacme-test",
      tracesEndpoint: "http://collector:4318/v1/traces",
      logsEndpoint: "http://collector:4318/v1/logs",
      headers: { "x-api-key": "abc", tenant: "acme" },
    });
  });
});

describe("parseOtlpHeaders", () => {
  it("parses comma separated key value pairs", () => {
    expect(parseOtlpHeaders("a=1,b = two words")).toEqual({
      a: "1",
      b: "two words",
    });
  });

  it("ignores malformed and empty entries", () => {
    expect(parseOtlpHeaders("a=1,,missing,b=2")).toEqual({
      a: "1",
      b: "2",
    });
  });
});
