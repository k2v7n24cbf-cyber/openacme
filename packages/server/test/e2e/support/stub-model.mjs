// Test-only stub LanguageModel built on the Vercel AI SDK's official test
// utilities (MockLanguageModelV3 + simulateReadableStream). NOT production
// code — injected via the `resolveModel` seam so e2e drives the real agent
// loop deterministically, no tokens, no network.
//
// Behaviour is scripted by the latest user message; embed a directive or get
// a canned echo:
//
//   [[mock:text:hello]]                  -> streams exactly "hello"
//   [[mock:tool:list_files:{"path":"."}]] -> one tool call, then closes on the
//                                            follow-up turn (loop-safe)
//   [[mock:chain]]                       -> two sequential tool calls, then text
//                                            (a multi-step agent loop)
//   [[mock:slow-long]]                   -> longer delayed stream for concurrency
//   [[mock:error:boom]]                  -> emits a stream error
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

const DIRECTIVE = /\[\[mock:(text|tool|error):([\s\S]*?)\]\]/;

function lastUserText(prompt) {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    return (m.content || [])
      .filter((p) => p && p.type === "text")
      .map((p) => p.text)
      .join("");
  }
  return "";
}

/** All text across every message (system + user) — used by structured
 *  doGenerate paths that need to read a manifest, not just the last turn. */
function allText(prompt) {
  const out = [];
  for (const m of prompt) {
    if (typeof m.content === "string") out.push(m.content);
    else
      for (const p of m.content || [])
        if (p && p.type === "text") out.push(p.text);
  }
  return out.join("\n");
}

function hasToolResult(prompt) {
  const last = prompt[prompt.length - 1];
  return !!last && last.role === "tool";
}

function plan(prompt) {
  const text = lastUserText(prompt);
  if (allText(prompt).includes("[[mock:slow-anywhere]]")) {
    return { kind: "slow", text: "tick ".repeat(40) };
  }
  // Multi-step loop: emit a tool call, then another after the first result,
  // then close with text. Counts how many tool results are already in scope.
  if (text.includes("[[mock:chain]]")) {
    const toolResults = prompt.filter((m) => m.role === "tool").length;
    if (toolResults < 2) {
      return { kind: "tool", toolName: "list_files", args: JSON.stringify({ path: "." }) };
    }
    return { kind: "text", text: `Chain complete after ${toolResults} tool calls.` };
  }
  if (hasToolResult(prompt)) {
    return { kind: "text", text: "Mock follow-up: tool result received." };
  }
  // A long, delayed stream so a turn can be cancelled mid-flight.
  if (text.includes("[[mock:slow-long]]")) {
    return { kind: "slow", text: "tick ".repeat(120) };
  }
  if (text.includes("[[mock:slow]]")) {
    return { kind: "slow", text: "tick ".repeat(40) };
  }
  const m = DIRECTIVE.exec(text);
  if (m) {
    const [, kind, payload] = m;
    if (kind === "text") return { kind: "text", text: payload };
    if (kind === "error") return { kind: "error", message: payload };
    if (kind === "tool") {
      const sep = payload.indexOf(":");
      const toolName = (sep === -1 ? payload : payload.slice(0, sep)).trim();
      const args = sep === -1 ? "{}" : payload.slice(sep + 1).trim() || "{}";
      return { kind: "tool", toolName, args };
    }
  }
  const echo = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  return { kind: "text", text: `Mock reply. You said: ${echo}` };
}

function textChunks(text, size = 12) {
  if (text === "") return [""];
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

// LanguageModelV3 usage is nested ({ inputTokens: { total, ... } }), not the
// old flat shape — the SDK reads `.total`, so a flat object records as 0.
const usage = {
  inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 8, reasoning: 0 },
};

// Tool-call ids must be unique across steps — a multi-step turn that reuses
// one id collapses to a single tool part when the client assembles by id.
let toolCallSeq = 0;

function streamChunks(prompt) {
  const script = plan(prompt);
  const chunks = [{ type: "stream-start", warnings: [] }];
  if (script.kind === "error") {
    chunks.push({ type: "error", error: new Error(script.message) });
    chunks.push({ type: "finish", finishReason: "error", usage });
  } else if (script.kind === "tool") {
    const id = `stub-call-${++toolCallSeq}`;
    chunks.push({ type: "tool-input-start", id, toolName: script.toolName });
    chunks.push({ type: "tool-input-delta", id, delta: script.args });
    chunks.push({ type: "tool-input-end", id });
    chunks.push({ type: "tool-call", toolCallId: id, toolName: script.toolName, input: script.args });
    chunks.push({ type: "finish", finishReason: "tool-calls", usage });
  } else {
    const id = "txt-1";
    chunks.push({ type: "text-start", id });
    for (const delta of textChunks(script.text)) chunks.push({ type: "text-delta", id, delta });
    chunks.push({ type: "text-end", id });
    chunks.push({ type: "finish", finishReason: "stop", usage });
  }
  return chunks;
}

/** A stub LanguageModel for the `resolveModel` seam. */
export function createStubModel(modelId = "stub-1") {
  return new MockLanguageModelV3({
    provider: "stub",
    modelId,
    doStream: async ({ prompt }) => {
      const chunks = streamChunks(prompt);
      // Slow stream → real per-chunk delay so a turn stays in-flight long
      // enough to be cancelled by a DELETE active-turn.
      const slow = plan(prompt).kind === "slow";
      return {
        stream: simulateReadableStream(
          slow ? { chunks, chunkDelayInMs: 120 } : { chunks }
        ),
      };
    },
    doGenerate: async ({ prompt, responseFormat }) => {
      // Structured calls (generateObject — title, extractor, memory selector)
      // want JSON back. Branch on the requested schema so each path gets a
      // shape it can parse instead of logging "could not parse the response".
      let text;
      if (responseFormat?.type === "json") {
        const schema = JSON.stringify(responseFormat.schema ?? {});
        if (schema.includes("selected_memories")) {
          // Memory recall: select every memory file the manifest mentions.
          // findRelevantMemories filters this to the real candidates, so the
          // recall surfaces deterministically without faking model judgement.
          const files = [...new Set(allText(prompt).match(/[\w-]+\.md/g) ?? [])];
          text = JSON.stringify({ selected_memories: files });
        } else {
          text = JSON.stringify({ title: "Mock session" });
        }
      } else {
        text = plan(prompt).kind === "text" ? plan(prompt).text : "";
      }
      return {
        content: text ? [{ type: "text", text }] : [],
        finishReason: "stop",
        usage,
        warnings: [],
      };
    },
  });
}
