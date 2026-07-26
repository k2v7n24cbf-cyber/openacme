#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const OPENACME_BASE_URL =
  process.env.OPENACME_TEST_BASE_URL ?? "http://127.0.0.1:3457";
const DATA_DIR =
  process.env.OPENACME_TEST_DATA_DIR ??
  path.join(os.homedir(), ".openacme-test");
const ENV_FILE =
  process.env.OPENACME_TEST_ENV_FILE ?? path.join(DATA_DIR, ".env");
const CONFIG_FILE = path.join(DATA_DIR, "config.yaml");
const AGENT_ID =
  process.env.OPENACME_COMPRESSION_AGENT_ID ?? "langfuse-canary-local";
const TURN_COUNT = positiveInt(process.env.OPENACME_COMPRESSION_TURNS, 5);
const TURN_TIMEOUT_MS = positiveInt(
  process.env.OPENACME_VERIFY_TURN_TIMEOUT_MS,
  240_000
);
const POLL_MS = positiveInt(process.env.OPENACME_VERIFY_POLL_MS, 2_000);
const LANGFUSE_TIMEOUT_MS = positiveInt(
  process.env.LANGFUSE_VERIFY_TIMEOUT_MS,
  180_000
);
const CANARY_HEALTH_URL =
  process.env.OPENACME_CANARY_HEALTH_URL ?? "http://127.0.0.1:45671/health";

class VerifyError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = "VerifyError";
    this.context = context;
  }
}

async function main() {
  const originalConfig = fs.readFileSync(CONFIG_FILE, "utf8");
  const env = loadEnvFile(ENV_FILE);
  const langfuse = {
    baseUrl: trimTrailingSlash(
      env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_BASE_URL ?? ""
    ),
    publicKey: env.LANGFUSE_PUBLIC_KEY ?? process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY ?? process.env.LANGFUSE_SECRET_KEY,
  };
  for (const [name, value] of Object.entries(langfuse)) {
    if (!value) throw new VerifyError(`Missing Langfuse config: ${name}`);
  }

  const fakeProvider = await ensureFakeProvider();
  let restored = false;
  try {
    fs.writeFileSync(
      CONFIG_FILE,
      withBehaviorOverrides(originalConfig, {
        compressionThresholdTokens: 20,
        compressionThresholdPercent: null,
        compressionProtectFirstN: 1,
        compressionTailTokenBudget: 20,
        compressionSummarizerInputCharBudget: 80_000,
      }),
      "utf8"
    );
    restartOpenAcmeTest();

    const health = await json("/api/health");
    if (health?.status !== "ok") {
      throw new VerifyError("OpenAcme test daemon is not healthy", { health });
    }
    const agent = await json(`/api/agents/${encodeURIComponent(AGENT_ID)}`);
    if (!agent?.id) {
      throw new VerifyError("Compression canary agent is unavailable", {
        agentId: AGENT_ID,
      });
    }

    const startedAt = new Date(Date.now() - 30_000);
    const markerStamp = new Date()
      .toISOString()
      .replace(/[-:.TZ]/g, "")
      .slice(0, 14);
    const marker = `OPENACME_COMPRESSION_CANARY_${markerStamp}`;
    const sessionId = randomUUID();
    const runs = [];
    for (let turn = 1; turn <= TURN_COUNT; turn += 1) {
      runs.push(
        await runPrompt({
          sessionId,
          turn,
          text:
            `${marker}_TURN_${turn}\n` +
            "Reply in one short sentence. " +
            "Payload for compression visibility: " +
            "alpha beta gamma delta ".repeat(80),
        })
      );
    }

    const usage = await waitForCompressionUsage(sessionId, startedAt);
    const timeline = await pollCompressionTimeline(sessionId);
    const summarizerUsage = usage.find((event) => event.kind === "summarizer");
    const extractorUsage = usage.find((event) => event.kind === "extractor");
    const failures = [];
    if (!summarizerUsage) failures.push("missing summarizer usage row");
    if (!extractorUsage) failures.push("missing memory-flush extractor usage row");
    for (const event of [summarizerUsage, extractorUsage].filter(Boolean)) {
      if (!event.traceId) failures.push(`${event.kind} usage missing traceId`);
      if (!event.spanId) failures.push(`${event.kind} usage missing spanId`);
      if (!event.forensicRunId) {
        failures.push(`${event.kind} usage missing forensicRunId`);
      }
      if (!event.forensicPath) {
        failures.push(`${event.kind} usage missing forensicPath`);
      }
    }

    const timelineTypes = uniqueSorted(
      timeline
        .map((event) =>
          typeof event.eventType === "string" ? event.eventType : undefined
        )
        .filter(Boolean)
    );
    for (const expected of [
      "session.compression.started",
      "session.compression.memory_flush.started",
      "session.compression.memory_flush.finished",
      "session.compression.summarizer.started",
      "session.compression.summarizer.finished",
      "session.compression.finished",
      "session.usage.finalized",
      "compression.memory_flush.start",
      "compression.memory_flush.finish",
      "compression.summarizer.start",
      "compression.summarizer.finish",
      "provider.request",
      "provider.response",
    ]) {
      if (!timelineTypes.includes(expected)) {
        failures.push(`timeline missing ${expected}`);
      }
    }

    const summarizerForensic = readForensicSummary(
      summarizerUsage?.forensicPath
    );
    const extractorForensic = readForensicSummary(extractorUsage?.forensicPath);
    if (!summarizerForensic.eventTypes.includes("compression.summarizer.start")) {
      failures.push("summarizer forensic missing compression.summarizer.start");
    }
    if (!summarizerForensic.eventTypes.includes("compression.summarizer.finish")) {
      failures.push("summarizer forensic missing compression.summarizer.finish");
    }
    if (
      !summarizerForensic.rawFiles.includes("compression/summarizer/prompt.txt")
    ) {
      failures.push("summarizer forensic missing raw prompt snapshot");
    }
    if (
      !extractorForensic.eventTypes.includes("compression.memory_flush.start")
    ) {
      failures.push("memory flush forensic missing compression.memory_flush.start");
    }
    if (
      !extractorForensic.rawFiles.includes(
        "compression/memory-flush/model-input.messages.json"
      )
    ) {
      failures.push("memory flush forensic missing raw messages snapshot");
    }

    let langfuseObservations = [];
    if (summarizerUsage?.traceId) {
      langfuseObservations = await pollLangfuseObservations(langfuse, {
        traceId: summarizerUsage.traceId,
        sessionId,
      });
      const names = uniqueSorted(
        langfuseObservations
          .map((obs) => (typeof obs.name === "string" ? obs.name : undefined))
          .filter(Boolean)
      );
      if (!names.includes("openacme.ai.helper")) {
        failures.push("Langfuse missing compression helper span");
      }
      if (
        !langfuseObservations.some((obs) =>
          observationHasEvidenceLocator(obs, summarizerUsage.forensicRunId)
        )
      ) {
        failures.push("Langfuse compression helper missing evidence locator");
      }
    }

    const timelineText = JSON.stringify(timeline);
    for (const forbidden of [
      "prompt.txt",
      "model-input.messages.json",
      "request.post-transform.body",
      "response.body",
      "/Users/",
      DATA_DIR,
    ]) {
      if (timelineText.includes(forbidden)) {
        failures.push(`timeline leaked raw/local detail ${forbidden}`);
      }
    }

    const summary = {
      checkedAt: new Date().toISOString(),
      openacmeBaseUrl: OPENACME_BASE_URL,
      dataDir: DATA_DIR,
      agentId: AGENT_ID,
      sessionId,
      marker,
      runs,
      usage: usage.map((event) => ({
        id: event.id,
        kind: event.kind,
        traceId: event.traceId,
        spanId: event.spanId,
        forensicRunId: event.forensicRunId,
        forensicPath: event.forensicPath,
        totalTokens: event.totalTokens,
        providerRequestCount: event.providerRequestCount,
      })),
      timeline: {
        eventCount: timeline.length,
        eventTypes: timelineTypes,
      },
      summarizerForensic,
      extractorForensic,
      langfuse: {
        observationCount: langfuseObservations.length,
        observationNames: uniqueSorted(
          langfuseObservations
            .map((obs) =>
              typeof obs.name === "string" ? obs.name : undefined
            )
            .filter(Boolean)
        ),
      },
      failures,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (failures.length > 0) {
      throw new VerifyError("Compression visibility verification failed", {
        failures,
      });
    }
  } finally {
    fs.writeFileSync(CONFIG_FILE, originalConfig, "utf8");
    restartOpenAcmeTest();
    restored = true;
    if (fakeProvider.started) fakeProvider.process.kill("SIGTERM");
    if (!restored) {
      console.error("config restore did not complete");
    }
  }
}

async function ensureFakeProvider() {
  try {
    const res = await fetch(CANARY_HEALTH_URL, {
      signal: AbortSignal.timeout(2_000),
    });
    if (res.ok) return { started: false };
  } catch {
    // Start one below.
  }
  const child = spawn(
    process.execPath,
    [path.join("ops", "langfuse-local", "openai-compatible-canary-server.mjs")],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    }
  );
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });
  await waitUntil(async () => {
    try {
      const res = await fetch(CANARY_HEALTH_URL, {
        signal: AbortSignal.timeout(2_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }, 15_000);
  return { started: true, process: child };
}

function restartOpenAcmeTest() {
  runChecked("pnpm", ["agent", "stop", "-d", DATA_DIR, "--no-service"]);
  runChecked("pnpm", [
    "agent",
    "start",
    "-d",
    DATA_DIR,
    "--no-service",
    "--no-browser",
  ]);
}

function runChecked(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new VerifyError("Command failed", {
      command,
      args,
      status: result.status,
      signal: result.signal,
    });
  }
}

async function runPrompt({ sessionId, turn, text }) {
  const userMessageId = randomUUID();
  const sse = await openSSE(`/api/sessions/${sessionId}/stream`);
  try {
    const res = await post("/api/chat", {
      agentId: AGENT_ID,
      sessionId,
      messages: [
        {
          id: userMessageId,
          role: "user",
          parts: [{ type: "text", text }],
        },
      ],
    });
    if (!res.ok) {
      throw new VerifyError("POST /api/chat failed", {
        turn,
        status: res.status,
        body: truncate(await safeText(res), 800),
      });
    }
    await sse.waitFor(
      (event) => event.event === "session_state" && event.data?.state === "idle",
      TURN_TIMEOUT_MS
    );
  } finally {
    sse.close();
  }
  return { turn, userMessageId };
}

async function waitForCompressionUsage(sessionId, startedAt) {
  const from = Math.floor(startedAt.getTime() / 1000);
  const deadline = Date.now() + 90_000;
  let last = [];
  while (Date.now() <= deadline) {
    const body = await json(`/api/usage/events?from=${from}&limit=200`);
    last = Array.isArray(body?.events) ? body.events : [];
    const sessionEvents = last.filter((event) => event.sessionId === sessionId);
    if (
      sessionEvents.some((event) => event.kind === "summarizer") &&
      sessionEvents.some((event) => event.kind === "extractor")
    ) {
      return sessionEvents;
    }
    await sleep(POLL_MS);
  }
  throw new VerifyError("Timed out waiting for compression usage rows", {
    sessionId,
    seen: last
      .filter((event) => event.sessionId === sessionId)
      .map((event) => ({ kind: event.kind, forensicRunId: event.forensicRunId })),
  });
}

async function pollCompressionTimeline(sessionId) {
  const deadline = Date.now() + 90_000;
  let last = [];
  while (Date.now() <= deadline) {
    const body = await json(
      `/api/sessions/${sessionId}/timeline?includeForensics=1&limit=500`
    );
    last = Array.isArray(body?.events) ? body.events : [];
    const types = new Set(last.map((event) => event?.eventType).filter(Boolean));
    if (
      types.has("session.compression.finished") &&
      types.has("compression.summarizer.finish") &&
      types.has("compression.memory_flush.finish")
    ) {
      return last;
    }
    await sleep(POLL_MS);
  }
  throw new VerifyError("Timed out waiting for compression timeline", {
    sessionId,
    lastTypes: uniqueSorted(last.map((event) => event?.eventType).filter(Boolean)),
  });
}

async function pollLangfuseObservations(langfuse, query) {
  const deadline = Date.now() + LANGFUSE_TIMEOUT_MS;
  let last = [];
  let lastError;
  while (Date.now() <= deadline) {
    try {
      last = await fetchLangfuseObservations(langfuse, query);
      if (last.some((obs) => obs.name === "openacme.ai.helper")) return last;
      lastError = undefined;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(POLL_MS);
  }
  throw new VerifyError("Timed out waiting for Langfuse compression observations", {
    traceId: query.traceId,
    lastNames: uniqueSorted(last.map((obs) => obs.name).filter(Boolean)),
    lastError,
  });
}

async function fetchLangfuseObservations(langfuse, query) {
  try {
    return await requestLangfuseObservations(
      langfuse,
      "/v2/observations",
      query,
      true
    );
  } catch (err) {
    const text =
      err instanceof Error
        ? `${err.message} ${JSON.stringify(err.context ?? {})}`
        : String(err);
    if (!text.includes("v4 write mode")) throw err;
    return requestLangfuseObservations(langfuse, "/observations", query, false);
  }
}

async function requestLangfuseObservations(
  langfuse,
  publicPath,
  query,
  includeFields
) {
  const url = langfusePublicUrl(langfuse.baseUrl, publicPath);
  url.searchParams.set("limit", "100");
  if (includeFields) url.searchParams.set("fields", "core,basic,usage");
  if (query.traceId) url.searchParams.set("traceId", query.traceId);
  if (query.sessionId) url.searchParams.set("sessionId", query.sessionId);

  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: `Basic ${Buffer.from(
        `${langfuse.publicKey}:${langfuse.secretKey}`
      ).toString("base64")}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new VerifyError("Langfuse observations request failed", {
      status: res.status,
      body: truncate(body, 800),
    });
  }
  const parsed = parseJsonSafe(body);
  if (Array.isArray(parsed)) return parsed.filter(isObject);
  if (Array.isArray(parsed?.data)) return parsed.data.filter(isObject);
  if (Array.isArray(parsed?.observations)) {
    return parsed.observations.filter(isObject);
  }
  return [];
}

function readForensicSummary(forensicPath) {
  if (!forensicPath) {
    return { eventTypes: [], rawFiles: [], evidenceRefs: [] };
  }
  const rows = readJsonl(path.join(forensicPath, "events.jsonl"));
  return {
    eventTypes: uniqueSorted(rows.map((row) => row.type).filter(Boolean)),
    rawFiles: rows
      .filter(
        (row) =>
          row.type === "raw_file.written" &&
          typeof row.data?.relativePath === "string"
      )
      .map((row) => row.data.relativePath)
      .sort(),
    evidenceRefs: uniqueSorted(
      rows
        .map((row) =>
          typeof row.data?.evidenceRef === "string"
            ? row.data.evidenceRef
            : undefined
        )
        .filter(Boolean)
    ),
  };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(parseJsonSafe)
    .filter(isObject);
}

async function openSSE(pathname) {
  const controller = new AbortController();
  const res = await fetch(`${OPENACME_BASE_URL}${pathname}`, {
    headers: {
      host: "127.0.0.1",
      accept: "text/event-stream",
    },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    throw new VerifyError("SSE open failed", { status: res.status, pathname });
  }

  const events = [];
  const waiters = [];
  let buf = "";
  const dec = new TextDecoder();
  const reader = res.body.getReader();
  const push = (event) => {
    events.push(event);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (waiters[index].pred(event)) {
        waiters[index].resolve(event);
        waiters.splice(index, 1);
      }
    }
  };
  const drain = () => {
    for (;;) {
      const index = buf.indexOf("\n\n");
      if (index === -1) return;
      parseSSEFrame(buf.slice(0, index), push);
      buf = buf.slice(index + 2);
    }
  };

  const first = await reader.read();
  if (!first.done) {
    buf += dec.decode(first.value, { stream: true });
    drain();
  }

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        drain();
      }
    } catch {
      // closed by abort
    }
  })();

  return {
    events,
    waitFor(pred, timeoutMs) {
      const existing = events.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new VerifyError("Timed out waiting for SSE event", {
              timeoutMs,
              seenEvents: events
                .map((event) => ({
                  event: event.event,
                  state: event.data?.state,
                }))
                .slice(-20),
            })
          );
        }, timeoutMs);
        waiters.push({
          pred,
          resolve(event) {
            clearTimeout(timer);
            resolve(event);
          },
        });
      });
    },
    close() {
      controller.abort();
    },
  };
}

function parseSSEFrame(frame, push) {
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return;
  const parsed = parseJsonSafe(data);
  if (isObject(parsed)) push({ event, data: parsed });
}

async function json(pathname) {
  const res = await fetch(`${OPENACME_BASE_URL}${pathname}`, {
    headers: { host: "127.0.0.1", accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new VerifyError("OpenAcme request failed", {
      method: "GET",
      pathname,
      status: res.status,
      body: truncate(body, 800),
    });
  }
  return parseJsonSafe(body);
}

function post(pathname, body) {
  return fetch(`${OPENACME_BASE_URL}${pathname}`, {
    method: "POST",
    headers: {
      host: "127.0.0.1",
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

function withBehaviorOverrides(raw, overrides) {
  const lines = raw.split(/\r?\n/);
  const behaviorIndex = lines.findIndex((line) => line.trim() === "behavior:");
  const overrideKeys = new Set(Object.keys(overrides));
  const overrideLines = Object.entries(overrides).map(
    ([key, value]) => `  ${key}: ${yamlScalar(value)}`
  );
  if (behaviorIndex === -1) {
    const next = raw.endsWith("\n") ? raw : `${raw}\n`;
    return `${next}behavior:\n${overrideLines.join("\n")}\n`;
  }
  let end = lines.length;
  for (let i = behaviorIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line && !line.startsWith(" ") && !line.startsWith("\t")) {
      end = i;
      break;
    }
  }
  const keptBehavior = lines
    .slice(behaviorIndex + 1, end)
    .filter((line) => {
      const match = /^\s*([A-Za-z0-9_]+)\s*:/.exec(line);
      return !match || !overrideKeys.has(match[1]);
    });
  return [
    ...lines.slice(0, behaviorIndex + 1),
    ...keptBehavior,
    ...overrideLines,
    ...lines.slice(end),
  ].join("\n");
}

function yamlScalar(value) {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(String(value));
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function langfusePublicUrl(baseUrl, publicPath) {
  const suffix = baseUrl.endsWith("/api/public")
    ? publicPath
    : `/api/public${publicPath}`;
  return new URL(`${baseUrl}${suffix}`);
}

function observationHasEvidenceLocator(obs, forensicRunId) {
  const text = JSON.stringify(obs);
  return (
    text.includes("openacme.forensic.evidence_ref") ||
    text.includes("evidence_ref") ||
    (forensicRunId && text.includes(`openacme://forensics/${forensicRunId}`))
  );
}

async function waitUntil(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) {
      throw new VerifyError("Timed out waiting for condition", { timeoutMs });
    }
    await sleep(POLL_MS);
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function parseJsonSafe(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isObject(value) {
  return !!value && typeof value === "object";
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function truncate(value, max) {
  if (typeof value !== "string") return "";
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  const context = err instanceof VerifyError ? err.context : undefined;
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...(context ? { context } : {}),
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
