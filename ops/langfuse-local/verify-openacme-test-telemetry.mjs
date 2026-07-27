#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const OPENACME_BASE_URL =
  process.env.OPENACME_TEST_BASE_URL ?? "http://127.0.0.1:3457";
const DATA_DIR = process.env.OPENACME_TEST_DATA_DIR ?? path.join(os.homedir(), ".openacme-test");
const ENV_FILE = process.env.OPENACME_TEST_ENV_FILE ?? path.join(DATA_DIR, ".env");
const LANGFUSE_TIMEOUT_MS = positiveInt(process.env.LANGFUSE_VERIFY_TIMEOUT_MS, 180_000);
const TURN_TIMEOUT_MS = positiveInt(process.env.OPENACME_VERIFY_TURN_TIMEOUT_MS, 240_000);
const POLL_MS = positiveInt(process.env.OPENACME_VERIFY_POLL_MS, 2_000);
const AGENT_ID = process.env.OPENACME_VERIFY_AGENT_ID;

const markerStamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const prompts = [
  {
    label: "direct_reply",
    expectTool: false,
    text:
      `OPENACME_LANGFUSE_CANARY_DIRECT_${markerStamp}\n` +
      "Reply with exactly one short sentence. Include the marker and say which agent you are.",
  },
  {
    label: "tool_canary",
    expectTool: true,
    text:
      `OPENACME_LANGFUSE_CANARY_TOOL_${markerStamp}\n` +
      "Use an available shell or execute_code tool to produce only this literal text: LANGFUSE_TOOL_CANARY_OK. Then reply in one sentence under 40 words with the marker and the literal tool output.",
  },
];

class VerifyError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = "VerifyError";
    this.context = context;
  }
}

async function main() {
  const env = loadEnvFile(ENV_FILE);
  const langfuse = {
    baseUrl: trimTrailingSlash(env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_BASE_URL ?? ""),
    publicKey: env.LANGFUSE_PUBLIC_KEY ?? process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY ?? process.env.LANGFUSE_SECRET_KEY,
  };
  for (const [name, value] of Object.entries(langfuse)) {
    if (!value) throw new VerifyError(`Missing Langfuse config: ${name}`, { envFile: ENV_FILE });
  }

  const health = await json("/api/health");
  if (health?.status !== "ok") {
    throw new VerifyError("OpenAcme test daemon is not healthy", { health });
  }

  const agents = await json("/api/agents");
  const agentList = normalizeAgents(agents);
  const agent = chooseAgent(agentList);
  if (!agent) throw new VerifyError("No agents returned by /api/agents", { count: agentList.length });

  const startedAt = new Date(Date.now() - 30_000);
  const runs = [];
  for (const prompt of prompts) {
    runs.push(await runPrompt({ agent, prompt, langfuse, startedAt }));
  }

  const summary = {
    checkedAt: new Date().toISOString(),
    openacmeBaseUrl: OPENACME_BASE_URL,
    dataDir: DATA_DIR,
    agent: {
      id: agent.id,
      name: agent.name,
      model: agent.model?.model,
      provider: agent.model?.provider,
    },
    runs,
  };
  console.log(JSON.stringify(summary, null, 2));

  const failures = runs.flatMap((run) => run.failures.map((failure) => `${run.label}: ${failure}`));
  if (failures.length > 0) {
    throw new VerifyError("Telemetry visibility verification failed", { failures });
  }
}

async function runPrompt({ agent, prompt, langfuse, startedAt }) {
  const sessionId = randomUUID();
  const userMessageId = randomUUID();
  const failures = [];
  const sse = await openSSE(`/api/sessions/${sessionId}/stream`);
  const turnStartedAt = new Date();
  try {
    const chatRes = await post("/api/chat", {
      agentId: agent.id,
      sessionId,
      messages: [
        {
          id: userMessageId,
          role: "user",
          parts: [{ type: "text", text: prompt.text }],
        },
      ],
    });
    if (!chatRes.ok) {
      const body = await safeText(chatRes);
      throw new VerifyError("POST /api/chat failed", {
        status: chatRes.status,
        body: truncate(body, 800),
        sessionId,
      });
    }

    await sse.waitFor((event) => event.event === "session_state" && event.data?.state === "idle", TURN_TIMEOUT_MS);
  } finally {
    sse.close();
  }

  const messages = await json(`/api/sessions/${sessionId}/messages`);
  const assistantText = extractAssistantText(messages);
  if (!assistantText) failures.push("missing assistant message");

  const usage = await waitForUsageEvent(sessionId, startedAt);
  if (!usage.traceId) failures.push("usage row missing traceId");
  if (!usage.spanId) failures.push("usage row missing spanId");
  if (!usage.forensicRunId) failures.push("usage row missing forensicRunId");
  if (!usage.forensicPath) failures.push("usage row missing forensicPath");

  const forensic = readForensicSummary(usage.forensicPath);
  for (const expected of ["agent.run.start", "agent.run.finish"]) {
    if (!forensic.eventTypes.includes(expected)) failures.push(`forensic missing ${expected}`);
  }
  if (prompt.expectTool && !forensic.eventTypes.includes("tool.finish")) {
    failures.push("forensic missing tool.finish");
  }
  const expectedProviderEvidenceRef =
    `openacme://forensics/${usage.forensicRunId}#provider.request:1`;
  const expectedProviderResponseEvidenceRef =
    `openacme://forensics/${usage.forensicRunId}#provider.response:1`;
  if (!forensic.evidenceRefs.includes(expectedProviderEvidenceRef)) {
    failures.push("forensic missing provider evidenceRef");
  }
  if (!forensic.evidenceRefs.includes(expectedProviderResponseEvidenceRef)) {
    failures.push("forensic missing provider.response evidenceRef");
  }
  if (
    prompt.expectTool &&
    !forensic.evidenceRefs.some((ref) =>
      ref.startsWith(`openacme://forensics/${usage.forensicRunId}#tool.finish:`)
    )
  ) {
    failures.push("forensic missing tool.finish evidenceRef");
  }

  const langfuseVisibility = await pollLangfuseVisibility(langfuse, {
    traceId: usage.traceId,
    sessionId,
    forensicRunId: usage.forensicRunId,
    fromStartTime: turnStartedAt,
  });
  const observations = langfuseVisibility.observations;
  const observationNames = uniqueSorted(
    observations.map((obs) => typeof obs.name === "string" ? obs.name : undefined).filter(Boolean)
  );
  const observationTypes = uniqueSorted(
    observations.map((obs) => typeof obs.type === "string" ? obs.type : undefined).filter(Boolean)
  );
  if (!langfuseVisibility.agentTurnVisible) {
    failures.push("Langfuse missing agent turn trace metadata/observation");
  }
  if (prompt.expectTool && !observationNames.includes("openacme.tool.execute")) {
    failures.push("Langfuse missing openacme.tool.execute");
  }
  const langfuseEvidenceLocatorNames = observationNamesWith(
    observations,
    (obs) => observationHasEvidenceLocator(obs, usage.forensicRunId)
  );

  const timeline = await pollSessionTimeline(sessionId, prompt.expectTool);
  const timelineTypes = uniqueSorted(
    timeline.map((event) => typeof event.eventType === "string" ? event.eventType : undefined).filter(Boolean)
  );
  const timelineSources = uniqueSorted(
    timeline.map((event) => typeof event.source === "string" ? event.source : undefined).filter(Boolean)
  );
  for (const expected of [
    "session.user_message.received",
    "session.turn.started",
    "session.turn.finished",
    "session.usage.finalized",
    "provider.request",
    "provider.response",
  ]) {
    if (!timelineTypes.includes(expected)) failures.push(`timeline missing ${expected}`);
  }
  if (prompt.expectTool) {
    for (const expected of ["tool.start", "tool.finish"]) {
      if (!timelineTypes.includes(expected)) failures.push(`timeline missing ${expected}`);
    }
  }
  const timelineText = JSON.stringify(timeline);
  if (!timelineText.includes(expectedProviderEvidenceRef)) {
    failures.push("timeline missing provider evidenceRef");
  }
  if (!timelineText.includes(expectedProviderResponseEvidenceRef)) {
    failures.push("timeline missing provider.response evidenceRef");
  }
  if (
    prompt.expectTool &&
    !timelineText.includes(`openacme://forensics/${usage.forensicRunId}#tool.finish:`)
  ) {
    failures.push("timeline missing tool.finish evidenceRef");
  }
  for (const forbidden of [
    "model-input.system.txt",
    "request.post-transform.body",
    "response.body",
    "result.post-spill.txt",
  ]) {
    if (timelineText.includes(forbidden)) {
      failures.push(`timeline leaked raw file reference ${forbidden}`);
    }
  }

  return {
    label: prompt.label,
    sessionId,
    userMessageId,
    traceId: usage.traceId ?? null,
    spanId: usage.spanId ?? null,
    forensicRunId: usage.forensicRunId ?? null,
    forensicPath: usage.forensicPath ?? null,
    usage: {
      kind: usage.kind,
      provider: usage.provider,
      model: usage.model,
      totalTokens: usage.totalTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      cachedInputTokens: usage.cachedInputTokens,
      providerRequestCount: usage.providerRequestCount,
      durationMs: usage.durationMs,
    },
    assistantPreview: truncate(assistantText, 220),
    forensic: {
      eventTypes: forensic.eventTypes,
      rawFiles: forensic.rawFiles,
      evidenceRefs: forensic.evidenceRefs,
      runCaptureRaw: forensic.runCaptureRaw,
    },
    langfuse: {
      traceName: langfuseVisibility.trace?.name ?? null,
      traceSessionId: langfuseVisibility.trace?.sessionId ?? null,
      traceMetadataKeys: Object.keys(langfuseVisibility.trace?.metadata ?? {}).sort(),
      agentTurnVisible: langfuseVisibility.agentTurnVisible,
      observationCount: observations.length,
      observationNames,
      observationTypes,
      withInput: observationNamesWith(observations, (obs) => obs.input != null),
      withOutput: observationNamesWith(observations, (obs) => obs.output != null),
      withUsage: observationNamesWith(observations, observationHasUsage),
      withForensicMetadata: observationNamesWith(observations, observationHasForensicMetadata),
      withEvidenceLocator: langfuseEvidenceLocatorNames,
    },
    timeline: {
      eventCount: timeline.length,
      eventTypes: timelineTypes,
      sources: timelineSources,
    },
    failures,
  };
}

async function waitForUsageEvent(sessionId, startedAt) {
  const from = Math.floor(startedAt.getTime() / 1000);
  const deadline = Date.now() + 60_000;
  let lastEvents = [];
  while (Date.now() <= deadline) {
    const body = await json(`/api/usage/events?from=${from}&limit=200`);
    lastEvents = Array.isArray(body?.events) ? body.events : [];
    const match = lastEvents.find((event) => event.sessionId === sessionId && event.kind === "interactive");
    if (match) return match;
    await sleep(POLL_MS);
  }
  throw new VerifyError("Timed out waiting for usage event", {
    sessionId,
    seenSessionIds: uniqueSorted(lastEvents.map((event) => event.sessionId).filter(Boolean)).slice(0, 10),
  });
}

function readForensicSummary(forensicPath) {
  if (!forensicPath) return { eventTypes: [], rawFiles: [], evidenceRefs: [], runCaptureRaw: null };
  const runJson = readJsonSafe(path.join(forensicPath, "run.json"));
  const eventPath = path.join(forensicPath, "events.jsonl");
  const rows = fs.existsSync(eventPath)
    ? fs.readFileSync(eventPath, "utf8").split("\n").filter(Boolean).map(parseJsonSafe).filter(Boolean)
    : [];
  const eventTypes = uniqueSorted(rows.map((row) => row.type).filter(Boolean));
  const rawFiles = rows
    .filter((row) => row.type === "raw_file.written" && typeof row.data?.relativePath === "string")
    .map((row) => row.data.relativePath)
    .sort();
  const evidenceRefs = uniqueSorted(
    rows
      .map((row) => typeof row.data?.evidenceRef === "string" ? row.data.evidenceRef : undefined)
      .filter(Boolean)
  );
  return {
    eventTypes,
    rawFiles,
    evidenceRefs,
    runCaptureRaw: runJson?.captureRaw ?? null,
  };
}

async function pollLangfuseVisibility(langfuse, query) {
  const deadline = Date.now() + LANGFUSE_TIMEOUT_MS;
  let lastObservations = [];
  let lastTrace = null;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      lastObservations = await fetchLangfuseObservations(langfuse, query);
      lastTrace = query.traceId
        ? await fetchLangfuseTrace(langfuse, query.traceId)
        : null;
      const agentTurnVisible = hasAgentTurnVisibility(
        lastTrace,
        lastObservations,
        query.forensicRunId,
      );
      if (agentTurnVisible) {
        return {
          observations: lastObservations,
          trace: lastTrace,
          agentTurnVisible,
        };
      }
      lastError = undefined;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(POLL_MS);
  }
  throw new VerifyError("Timed out waiting for Langfuse observations", {
    traceId: query.traceId,
    sessionId: query.sessionId,
    forensicRunId: query.forensicRunId,
    lastTraceName: lastTrace?.name,
    lastTraceMetadataKeys: Object.keys(lastTrace?.metadata ?? {}).sort(),
    lastNames: uniqueSorted(lastObservations.map((obs) => obs.name).filter(Boolean)),
    lastError,
  });
}

async function pollSessionTimeline(sessionId, expectTool) {
  const deadline = Date.now() + 60_000;
  let last = [];
  while (Date.now() <= deadline) {
    const body = await json(`/api/sessions/${sessionId}/timeline?includeForensics=1&limit=300`);
    last = Array.isArray(body?.events) ? body.events : [];
    const types = new Set(last.map((event) => event?.eventType).filter(Boolean));
    const hasBase =
      types.has("session.user_message.received") &&
      types.has("session.turn.started") &&
      types.has("session.turn.finished") &&
      types.has("session.usage.finalized") &&
      types.has("provider.request") &&
      types.has("provider.response");
    const hasTool = !expectTool || (types.has("tool.start") && types.has("tool.finish"));
    if (hasBase && hasTool) return last;
    await sleep(POLL_MS);
  }
  throw new VerifyError("Timed out waiting for session timeline events", {
    sessionId,
    lastTypes: uniqueSorted(last.map((event) => event?.eventType).filter(Boolean)),
  });
}

async function fetchLangfuseObservations(langfuse, query) {
  try {
    return await requestLangfuseObservations(langfuse, "/v2/observations", query, true);
  } catch (err) {
    const text = err instanceof Error ? `${err.message} ${JSON.stringify(err.context ?? {})}` : String(err);
    if (!text.includes("v4 write mode")) throw err;
    return requestLangfuseObservations(langfuse, "/observations", query, false);
  }
}

async function requestLangfuseObservations(langfuse, publicPath, query, includeFields) {
  const url = langfusePublicUrl(langfuse.baseUrl, publicPath);
  url.searchParams.set("limit", "100");
  if (includeFields) url.searchParams.set("fields", "core,basic,usage");
  if (query.traceId) url.searchParams.set("traceId", query.traceId);
  if (query.sessionId) url.searchParams.set("sessionId", query.sessionId);
  if (query.fromStartTime) url.searchParams.set("fromStartTime", query.fromStartTime.toISOString());
  url.searchParams.set("toStartTime", new Date(Date.now() + 60_000).toISOString());

  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: `Basic ${Buffer.from(`${langfuse.publicKey}:${langfuse.secretKey}`).toString("base64")}`,
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
  if (Array.isArray(parsed)) return parsed.filter((item) => item && typeof item === "object");
  if (Array.isArray(parsed?.data)) return parsed.data.filter((item) => item && typeof item === "object");
  if (Array.isArray(parsed?.observations)) return parsed.observations.filter((item) => item && typeof item === "object");
  return [];
}

async function fetchLangfuseTrace(langfuse, traceId) {
  const res = await fetch(langfusePublicUrl(langfuse.baseUrl, `/traces/${traceId}`), {
    headers: {
      accept: "application/json",
      authorization: `Basic ${Buffer.from(`${langfuse.publicKey}:${langfuse.secretKey}`).toString("base64")}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new VerifyError("Langfuse trace request failed", {
      status: res.status,
      body: truncate(body, 800),
    });
  }
  const parsed = parseJsonSafe(body);
  return parsed && typeof parsed === "object" ? parsed : null;
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
    throw new VerifyError("SSE open failed", { status: res.status, path: pathname });
  }

  const events = [];
  const waiters = [];
  let buf = "";
  const dec = new TextDecoder();
  const reader = res.body.getReader();

  const push = (event) => {
    events.push(event);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].pred(event)) {
        waiters[i].resolve(event);
        waiters.splice(i, 1);
      }
    }
  };
  const drain = () => {
    for (;;) {
      const idx = buf.indexOf("\n\n");
      if (idx === -1) return;
      parseSSEFrame(buf.slice(0, idx), push);
      buf = buf.slice(idx + 2);
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
          const idx = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new VerifyError("Timed out waiting for SSE event", {
            timeoutMs,
            seenEvents: events.map((event) => ({ event: event.event, state: event.data?.state })).slice(-20),
          }));
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
  if (parsed && typeof parsed === "object") push({ event, data: parsed });
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
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function normalizeAgents(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.agents)) return body.agents;
  if (Array.isArray(body?.data)) return body.data;
  return [];
}

function chooseAgent(agents) {
  if (AGENT_ID) return agents.find((agent) => agent.id === AGENT_ID);
  return (
    agents.find((agent) => agent.id === "acme") ??
    agents.find((agent) => String(agent.name ?? "").toLowerCase() === "acme") ??
    agents[0]
  );
}

function extractAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => Array.isArray(message.parts) ? message.parts : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function langfusePublicUrl(baseUrl, publicPath) {
  const suffix = baseUrl.endsWith("/api/public") ? publicPath : `/api/public${publicPath}`;
  return new URL(`${baseUrl}${suffix}`);
}

function readJsonSafe(file) {
  if (!fs.existsSync(file)) return null;
  return parseJsonSafe(fs.readFileSync(file, "utf8"));
}

function parseJsonSafe(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function observationNamesWith(observations, pred) {
  return uniqueSorted(
    observations
      .filter(pred)
      .map((obs) => typeof obs.name === "string" ? obs.name : undefined)
      .filter(Boolean)
  );
}

function observationHasUsage(obs) {
  return obs.usage != null || obs.usageDetails != null || obs.promptTokens != null || obs.totalTokens != null;
}

function observationHasForensicMetadata(obs) {
  const metadata = obs.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  if (metadata.forensicRunId || metadata.forensic_run_id) return true;
  const attributes = metadata.attributes;
  return !!(
    attributes &&
    typeof attributes === "object" &&
    (attributes["openacme.forensic.run_id"] ||
      attributes["langfuse.trace.metadata.forensic_run_id"])
  );
}

function observationHasEvidenceLocator(obs, forensicRunId) {
  const text = JSON.stringify(obs);
  return (
    text.includes("openacme.forensic.evidence_ref") ||
    text.includes("evidence_ref") ||
    (forensicRunId && text.includes(`openacme://forensics/${forensicRunId}`))
  );
}

function hasAgentTurnVisibility(trace, observations, forensicRunId) {
  if (trace?.name === "openacme.agent.turn") return true;
  if (metadataMatchesAgentTurn(trace?.metadata, forensicRunId)) return true;
  return observations.some((obs) => {
    if (obs?.name === "openacme.agent.turn") return true;
    return metadataMatchesAgentTurn(obs?.metadata, forensicRunId);
  });
}

function metadataMatchesAgentTurn(metadata, forensicRunId) {
  if (!metadata || typeof metadata !== "object") return false;
  const text = JSON.stringify(metadata);
  if (metadata.span_type === "agent_turn") return true;
  if (text.includes("openacme.span.type") && text.includes("agent_turn")) {
    return true;
  }
  if (!forensicRunId) return false;
  return (
    metadata.forensic_run_id === forensicRunId ||
    metadata.forensicRunId === forensicRunId ||
    text.includes(`openacme://forensics/${forensicRunId}#agent.run`)
  );
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
  console.error(JSON.stringify({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    ...(context ? { context } : {}),
  }, null, 2));
  process.exitCode = 1;
});
