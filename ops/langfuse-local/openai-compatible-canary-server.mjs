#!/usr/bin/env node
import http from "node:http";
import { randomUUID } from "node:crypto";

const HOST = process.env.CANARY_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.CANARY_PORT ?? "45671", 10);
const MODEL = process.env.CANARY_MODEL ?? "openacme-local-canary";
const TOOL_OUTPUT = "LANGFUSE_TOOL_CANARY_OK";

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true, model: MODEL });
    }
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      return json(res, 200, { object: "list", data: [{ id: MODEL, object: "model" }] });
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      return json(res, 404, { error: { message: "not_found" } });
    }

    const body = parseJson(await readBody(req));
    if (!body || typeof body !== "object") {
      return json(res, 400, { error: { message: "invalid_json" } });
    }

    const summary = summarizeRequest(body);
    console.error(JSON.stringify({ type: "canary.request", ...summary }));

    const script = buildScript(body);
    if (body.stream === true) return streamCompletion(res, script);
    return json(res, 200, completion(script));
  } catch (err) {
    console.error(JSON.stringify({
      type: "canary.error",
      error: err instanceof Error ? err.message : String(err),
    }));
    if (!res.headersSent) json(res, 500, { error: { message: "canary_error" } });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({
    ok: true,
    baseUrl: `http://${HOST}:${PORT}/v1`,
    healthUrl: `http://${HOST}:${PORT}/health`,
    model: MODEL,
  }));
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(130)));

function buildScript(body) {
  const text = allMessageText(body.messages);
  const marker = /OPENACME_LANGFUSE_CANARY_[A-Z0-9_]+/.exec(text)?.[0] ?? "OPENACME_LANGFUSE_CANARY";
  const hasToolResult = Array.isArray(body.messages) && body.messages.some((message) => message?.role === "tool");
  const wantsTool = text.includes("OPENACME_LANGFUSE_CANARY_TOOL") && !hasToolResult;
  if (wantsTool) {
    return {
      kind: "tool",
      marker,
      toolName: chooseToolName(body.tools),
      args: { command: `printf ${TOOL_OUTPUT}`, timeout: 5000 },
    };
  }
  return {
    kind: "text",
    marker,
    text: text.includes("OPENACME_LANGFUSE_CANARY_TOOL")
      ? `${marker} ${TOOL_OUTPUT}`
      : `${marker} local canary response from ${MODEL}.`,
  };
}

function chooseToolName(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "shell";
  const names = tools
    .map((tool) => tool?.function?.name)
    .filter((name) => typeof name === "string" && name.length > 0);
  return names.find((name) => name === "shell") ?? names[0] ?? "shell";
}

function streamCompletion(res, script) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  if (script.kind === "tool") {
    const id = `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const args = JSON.stringify(script.args);
    sse(res, chunk({
      delta: {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id,
            type: "function",
            function: { name: script.toolName, arguments: "" },
          },
        ],
      },
    }));
    sse(res, chunk({
      delta: {
        tool_calls: [
          {
            index: 0,
            function: { arguments: args },
          },
        ],
      },
    }));
    sse(res, chunk({ delta: {}, finish_reason: "tool_calls" }));
    sse(res, usageChunk());
    res.end("data: [DONE]\n\n");
    return;
  }

  sse(res, chunk({ delta: { role: "assistant", content: "" } }));
  for (const part of textChunks(script.text)) {
    sse(res, chunk({ delta: { content: part } }));
  }
  sse(res, chunk({ delta: {}, finish_reason: "stop" }));
  sse(res, usageChunk());
  res.end("data: [DONE]\n\n");
}

function completion(script) {
  if (script.kind === "tool") {
    return {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: now(),
      model: MODEL,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
                type: "function",
                function: {
                  name: script.toolName,
                  arguments: JSON.stringify(script.args),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: usage(),
    };
  }
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: now(),
    model: MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: script.text },
        finish_reason: "stop",
      },
    ],
    usage: usage(),
  };
}

function chunk({ delta, finish_reason = null }) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: now(),
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason }],
  };
}

function usageChunk() {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: now(),
    model: MODEL,
    choices: [],
    usage: usage(),
  };
}

function usage() {
  return {
    prompt_tokens: 8,
    completion_tokens: 8,
    total_tokens: 16,
  };
}

function sse(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(value)}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("request_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function summarizeRequest(body) {
  return {
    model: typeof body.model === "string" ? body.model : undefined,
    stream: body.stream === true,
    messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
    toolNames: Array.isArray(body.tools)
      ? body.tools.map((tool) => tool?.function?.name).filter(Boolean)
      : [],
  };
}

function allMessageText(messages) {
  if (!Array.isArray(messages)) return "";
  const out = [];
  for (const message of messages) {
    if (typeof message?.content === "string") out.push(message.content);
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (typeof part?.text === "string") out.push(part.text);
      }
    }
  }
  return out.join("\n");
}

function textChunks(value, size = 12) {
  const chunks = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks.length > 0 ? chunks : [""];
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function now() {
  return Math.floor(Date.now() / 1000);
}
