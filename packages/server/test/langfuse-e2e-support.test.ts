import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchLangfuseObservations,
  resolveLangfuseE2EConfig,
  type EnabledLangfuseE2EConfig,
} from "./e2e/support/langfuse.js";

describe("Langfuse e2e support", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays disabled unless the explicit live flag and credentials are set", () => {
    const cfg = resolveLangfuseE2EConfig({});

    expect(cfg.enabled).toBe(false);
    if (!cfg.enabled) {
      expect(cfg.missing).toEqual(
        expect.arrayContaining([
          "OPENACME_E2E_LANGFUSE",
          "LANGFUSE_BASE_URL",
          "LANGFUSE_PUBLIC_KEY",
          "LANGFUSE_SECRET_KEY",
        ]),
      );
    }
  });

  it("resolves the live config without requiring OPENACME_OBSERVABILITY", () => {
    const cfg = resolveLangfuseE2EConfig({
      HOME: "/tmp/home",
      OPENACME_E2E_LANGFUSE: "1",
      LANGFUSE_BASE_URL: "https://cloud.langfuse.com/",
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
    });

    expect(cfg.enabled).toBe(true);
    if (cfg.enabled) {
      expect(cfg.baseUrl).toBe("https://cloud.langfuse.com");
      expect(cfg.dataDirRoot).toContain(".openacme-test/langfuse-e2e");
      expect(cfg.timeoutMs).toBe(120_000);
      expect(cfg.pollMs).toBe(3_000);
    }
  });

  it("queries the Langfuse public observations endpoint with Basic auth", async () => {
    let requestedUrl: URL | null = null;
    let requestedAuth: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requestedUrl = new URL(String(input));
        requestedAuth = new Headers(init?.headers).get("authorization");
        return new Response(
          JSON.stringify({
            data: [{ name: "openacme.agent.turn", traceId: "trace-1" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const cfg: EnabledLangfuseE2EConfig = {
      enabled: true,
      baseUrl: "https://lf.example.com/api/public",
      publicKey: "pk-test",
      secretKey: "sk-test",
      envFile: "/tmp/.env",
      dataDirRoot: "/tmp/openacme-langfuse-e2e",
      keepDataDir: false,
      timeoutMs: 1_000,
      pollMs: 10,
    };

    const observations = await fetchLangfuseObservations(cfg, {
      traceId: "trace-1",
      sessionId: "session-1",
      fromStartTime: new Date("2026-07-25T00:00:00.000Z"),
      toStartTime: new Date("2026-07-25T00:05:00.000Z"),
    });

    expect(observations).toEqual([
      { name: "openacme.agent.turn", traceId: "trace-1" },
    ]);
    expect(requestedUrl?.origin).toBe("https://lf.example.com");
    expect(requestedUrl?.pathname).toBe("/api/public/v2/observations");
    expect(requestedUrl?.searchParams.get("fields")).toBe(
      "core,basic,metadata,usage",
    );
    expect(requestedUrl?.searchParams.get("traceId")).toBe("trace-1");
    expect(requestedUrl?.searchParams.get("sessionId")).toBe("session-1");
    expect(requestedAuth).toBe(
      `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`,
    );
  });

  it("falls back to legacy observations on self-hosted Langfuse v3", async () => {
    const requestedPaths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        requestedPaths.push(url.pathname);
        if (url.pathname.endsWith("/v2/observations")) {
          return new Response(
            JSON.stringify({
              message:
                "The observations v2 API is only available in a Langfuse v4 write mode.",
            }),
            { status: 404, statusText: "Not Found" },
          );
        }
        return new Response(
          JSON.stringify({
            data: [{ name: "openacme.tool.execute", traceId: "trace-1" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const cfg: EnabledLangfuseE2EConfig = {
      enabled: true,
      baseUrl: "http://localhost:3000",
      publicKey: "pk-test",
      secretKey: "sk-test",
      envFile: "/tmp/.env",
      dataDirRoot: "/tmp/openacme-langfuse-e2e",
      keepDataDir: false,
      timeoutMs: 1_000,
      pollMs: 10,
    };

    const observations = await fetchLangfuseObservations(cfg, {
      traceId: "trace-1",
    });

    expect(requestedPaths).toEqual([
      "/api/public/v2/observations",
      "/api/public/observations",
    ]);
    expect(observations).toEqual([
      { name: "openacme.tool.execute", traceId: "trace-1" },
    ]);
  });
});
