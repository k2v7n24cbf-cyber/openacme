import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startE2EServer, openSSE, type E2EServer } from "./support/harness.js";
import { makeClient, isState, waitUntil } from "./support/client.js";
import {
  loadLangfuseE2EEnv,
  observationNames,
  pollLangfuseObservations,
  resolveLangfuseE2EConfig,
  type EnabledLangfuseE2EConfig,
} from "./support/langfuse.js";

loadLangfuseE2EEnv();

const langfuseConfig = resolveLangfuseE2EConfig();
const liveConfig = langfuseConfig.enabled ? langfuseConfig : null;
const disabledReason = langfuseConfig.enabled ? "" : langfuseConfig.reason;
const describeLive = liveConfig ? describe.sequential : describe.skip;

type ShutdownTelemetry = () => Promise<void>;

describeLive(
  liveConfig
    ? "langfuse live visibility (e2e)"
    : `langfuse live visibility (e2e skipped: ${disabledReason})`,
  () => {
    let srv: E2EServer;
    let c: ReturnType<typeof makeClient>;
    let shutdownTelemetry: ShutdownTelemetry | null = null;
    let telemetryShutdown = false;

    beforeAll(async () => {
      const cfg = requireLiveConfig(liveConfig);
      const dataDir = createRunDataDir(cfg);
      applyOpenAcmeLiveEnv(cfg, dataDir);

      const telemetry = await import("@openacme/config/telemetry-bootstrap");
      const telemetryConfig = telemetry.initializeOpenAcmeTelemetry(
        process.env,
      );
      expect(
        telemetryConfig.enabled,
        "OpenAcme telemetry must initialize",
      ).toBe(true);
      expect(telemetryConfig.backend).toBe("langfuse");
      shutdownTelemetry = telemetry.shutdownOpenAcmeTelemetry;

      srv = await startE2EServer({
        dataDir,
        cleanupDataDir: !cfg.keepDataDir,
      });
      c = makeClient(srv.baseUrl);
      await c.createAgent("helper");
    });

    afterAll(async () => {
      await srv?.close();
      if (shutdownTelemetry && !telemetryShutdown) {
        await shutdownTelemetry();
      }
    });

    it("exports tool turns and reads success plus logical failure metadata back from Langfuse", async () => {
      const cfg = requireLiveConfig(liveConfig);
      const startedAt = new Date(Date.now() - 60_000);
      const sessionId = randomUUID();
      const sse = await openSSE(
        `${srv.baseUrl}/api/sessions/${sessionId}/stream`,
      );

      try {
        await c.chat(
          "helper",
          'confirm visibility [[mock:tool:ping_user:{"message":"Langfuse visibility canary"}]]',
          sessionId,
        );
        await sse.waitFor(isState("idle"), 25_000);
      } finally {
        sse.close();
      }

      const usage = await waitForUsageEvent(c, sessionId, startedAt);
      expect(usage.traceId).toMatch(/^[a-f0-9]{32}$/);
      expect(usage.spanId).toMatch(/^[a-f0-9]{16}$/);
      expect(usage.forensicRunId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(usage.forensicPath).toBeTruthy();

      const eventTypes = readForensicEventTypes(usage.forensicPath!);
      expect(eventTypes).toEqual(
        expect.arrayContaining([
          "agent.run.start",
          "agent.run.finish",
          "tool.start",
          "tool.finish",
        ]),
      );

      const failureStartedAt = new Date(Date.now() - 60_000);
      const failureSessionId = randomUUID();
      const failureArgs = JSON.stringify({
        command: "sh -c 'printf OPENACME_LANGFUSE_FAILURE_CANARY; exit 7'",
        timeout: 5000,
      });
      const failureSse = await openSSE(
        `${srv.baseUrl}/api/sessions/${failureSessionId}/stream`,
      );

      try {
        await c.chat(
          "helper",
          `confirm shell failure [[mock:tool:shell:${failureArgs}]]`,
          failureSessionId,
        );
        await failureSse.waitFor(isState("idle"), 25_000);
      } finally {
        failureSse.close();
      }

      const failureUsage = await waitForUsageEvent(
        c,
        failureSessionId,
        failureStartedAt,
      );
      expect(failureUsage.traceId).toMatch(/^[a-f0-9]{32}$/);
      expect(failureUsage.spanId).toMatch(/^[a-f0-9]{16}$/);
      expect(failureUsage.forensicPath).toBeTruthy();

      const failureToolEvent = readForensicEvents(
        failureUsage.forensicPath!,
      ).find(
        (event) =>
          event.type === "tool.finish" &&
          (event.data as { toolName?: unknown } | undefined)?.toolName ===
            "shell",
      );
      expect(failureToolEvent?.data).toMatchObject({
        toolName: "shell",
        executionStatus: "ok",
        resultStatus: "failure",
        resultClassifier: "shell",
        failureKind: "command_exit_nonzero",
        failureMessage: "Command exited with code 7",
        exitCode: 7,
      });

      if (!shutdownTelemetry)
        throw new Error("telemetry shutdown helper was not initialized");
      await shutdownTelemetry();
      telemetryShutdown = true;

      const observations = await pollLangfuseObservations(cfg, {
        traceId: usage.traceId!,
        sessionId,
        fromStartTime: startedAt,
        expectedNames: ["openacme.agent.turn", "openacme.tool.execute"],
      });
      expect(observationNames(observations)).toEqual(
        expect.arrayContaining([
          "openacme.agent.turn",
          "openacme.tool.execute",
        ]),
      );

      const failureObservations = await pollLangfuseObservations(cfg, {
        traceId: failureUsage.traceId!,
        sessionId: failureSessionId,
        fromStartTime: failureStartedAt,
        expectedNames: ["openacme.agent.turn", "openacme.tool.execute"],
      });
      const failureToolObservation = failureObservations.find(
        (obs) =>
          obs.name === "openacme.tool.execute" &&
          readObservationValue(obs, "tool_result_status") === "failure",
      );
      expect(failureToolObservation).toBeTruthy();
      expect(readObservationValue(failureToolObservation, "tool_execution_status")).toBe(
        "ok",
      );
      expect(readObservationValue(failureToolObservation, "tool_result_status")).toBe(
        "failure",
      );
      expect(readObservationValue(failureToolObservation, "tool_result_classifier")).toBe(
        "shell",
      );
      expect(readObservationValue(failureToolObservation, "tool_failure_kind")).toBe(
        "command_exit_nonzero",
      );
      expect(readObservationValue(failureToolObservation, "tool_failure_message")).toBe(
        "Command exited with code 7",
      );
      expect(String(readObservationValue(failureToolObservation, "tool_exit_code"))).toBe(
        "7",
      );
    });
  },
);

function requireLiveConfig(
  cfg: EnabledLangfuseE2EConfig | null,
): EnabledLangfuseE2EConfig {
  if (!cfg) throw new Error(disabledReason);
  return cfg;
}

function createRunDataDir(cfg: EnabledLangfuseE2EConfig): string {
  mkdirSync(cfg.dataDirRoot, { recursive: true, mode: 0o700 });
  return mkdtempSync(path.join(cfg.dataDirRoot, "run-"));
}

function applyOpenAcmeLiveEnv(
  cfg: EnabledLangfuseE2EConfig,
  dataDir: string,
): void {
  process.env["OPENACME_DATA_DIR"] = dataDir;
  process.env["OPENACME_OBSERVABILITY"] = "langfuse";
  process.env["OPENACME_TELEMETRY_SERVICE_NAME"] =
    process.env["OPENACME_TELEMETRY_SERVICE_NAME"] ??
    `openacme-langfuse-e2e-${process.pid}`;
  process.env["LANGFUSE_BASE_URL"] = cfg.baseUrl;
  process.env["LANGFUSE_PUBLIC_KEY"] = cfg.publicKey;
  process.env["LANGFUSE_SECRET_KEY"] = cfg.secretKey;
  process.env["OPENACME_AI_FORENSICS"] = "1";
  process.env["OPENACME_AI_FORENSICS_CAPTURE_RAW"] = "1";
  process.env["OPENACME_AI_FORENSICS_DIR"] = path.join(dataDir, "ai-forensics");
  process.env["OPENACME_AI_TELEMETRY_RECORD_INPUTS"] =
    process.env["OPENACME_AI_TELEMETRY_RECORD_INPUTS"] ?? "1";
  process.env["OPENACME_AI_TELEMETRY_RECORD_OUTPUTS"] =
    process.env["OPENACME_AI_TELEMETRY_RECORD_OUTPUTS"] ?? "1";
}

async function waitForUsageEvent(
  c: ReturnType<typeof makeClient>,
  sessionId: string,
  startedAt: Date,
): Promise<{
  traceId?: string | null;
  spanId?: string | null;
  forensicRunId?: string | null;
  forensicPath?: string | null;
}> {
  let match:
    | {
        traceId?: string | null;
        spanId?: string | null;
        forensicRunId?: string | null;
        forensicPath?: string | null;
      }
    | undefined;
  const from = Math.floor(startedAt.getTime() / 1000);
  await waitUntil(
    async () => {
      const { events } = await c.json(
        `/api/usage/events?from=${from}&limit=200`,
      );
      match = events.find(
        (event: any) =>
          event.sessionId === sessionId && event.kind === "interactive",
      );
      return Boolean(
        match?.traceId &&
        match?.spanId &&
        match?.forensicRunId &&
        match?.forensicPath,
      );
    },
    { timeoutMs: 20_000, intervalMs: 250 },
  );
  if (!match) throw new Error(`usage event not found for session ${sessionId}`);
  return match;
}

interface ForensicEvent {
  type?: string;
  data?: unknown;
}

function readForensicEvents(forensicPath: string): ForensicEvent[] {
  const eventsPath = path.join(forensicPath, "events.jsonl");
  expect(existsSync(eventsPath), `forensic events file ${eventsPath}`).toBe(
    true,
  );
  return readFileSync(eventsPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as ForensicEvent;
      } catch {
        return {};
      }
    })
    .filter((event) => typeof event.type === "string");
}

function readForensicEventTypes(forensicPath: string): string[] {
  return readForensicEvents(forensicPath)
    .map((event) => event.type)
    .filter((type): type is string => Boolean(type));
}

function readObservationValue(
  value: unknown,
  key: string,
): string | number | boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readObservationValue(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key || entryKey.endsWith(`.${key}`)) {
      if (
        typeof entryValue === "string" ||
        typeof entryValue === "number" ||
        typeof entryValue === "boolean"
      ) {
        return entryValue;
      }
    }
    const nested = readObservationValue(entryValue, key);
    if (nested !== undefined) return nested;
  }
  return undefined;
}
