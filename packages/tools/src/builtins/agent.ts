import { z } from "zod";
import { registry } from "../registry.js";
import { getCurrentAgentId, getCurrentSessionId } from "../session-context.js";

/**
 * Minimal agent shape this tool surfaces to peers. Defined locally so
 * `@openacme/tools` doesn't pull in `@openacme/config` at runtime —
 * `bindAgentTool` is wired up by `AgentManager` at boot, same pattern as
 * `bindSessionSearch` / `bindSkillView`.
 */
export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  instantMessagesEnabled?: boolean;
}

export interface PeerNote {
  /** UTF-8 body of `peers/<id>.md` (frontmatter included if present). */
  content: string;
  mtimeMs: number;
}

export interface AgentToolBindings {
  /** Every agent currently registered in the workforce. Self is included;
   *  the tool filters it out before returning to the caller. */
  listAgents(): AgentSummary[];
  /** Read the calling agent's peer note for `peerId`, or null if absent.
   *  Resolves to `<dataDir>/agents/<callerId>/memory/peers/<peerId>.md`. */
  peerNoteFor(callerId: string, peerId: string): PeerNote | null;
}

let bindings: AgentToolBindings | null = null;

export function bindAgentTool(b: AgentToolBindings): void {
  bindings = b;
}

export interface AgentAskRequest {
  callerAgentId: string;
  callerSessionId: string;
  targetAgentId: string;
  message: string;
  sessionId?: string;
  timeoutMs: number;
}

export interface AgentAskResult {
  ok: boolean;
  target_agent_id?: string;
  session_id?: string;
  new_session?: boolean;
  user_message_id?: string;
  assistant_message_id?: string | null;
  response?: string;
  assistant_message?: {
    role: "assistant";
    parts: unknown[];
  } | null;
  error?: string;
}

export interface AgentAskBindings {
  ask(request: AgentAskRequest): Promise<AgentAskResult>;
}

let askBindings: AgentAskBindings | null = null;

export function bindAgentAsk(b: AgentAskBindings): void {
  askBindings = b;
}

// Half of MAX_MEMORY_BYTES (4096) — the tool returns N peer notes at
// once, so each individual one gets a tighter budget than the recall
// pipeline applies to a single surfaced memory.
const MAX_PEER_NOTE_BYTES = 2048;
const DEFAULT_LIMIT = 25;
const AGENT_ASK_DEFAULT_TIMEOUT_MS = 5 * 60_000;
const AGENT_ASK_MIN_TIMEOUT_MS = 60_000;
const AGENT_ASK_MAX_TIMEOUT_MS = 15 * 60_000;

function truncateNote(
  content: string,
  peerId: string
): { content: string; truncated: boolean } {
  if (Buffer.byteLength(content, "utf-8") <= MAX_PEER_NOTE_BYTES) {
    return { content, truncated: false };
  }
  const buf = Buffer.from(content, "utf-8").subarray(0, MAX_PEER_NOTE_BYTES);
  // Cut at the last newline so we don't end mid-line. Invalid trailing
  // UTF-8 bytes from `subarray` get U+FFFD on `toString`, not a crash.
  const cut = buf.lastIndexOf(0x0a);
  const head = (cut > 0 ? buf.subarray(0, cut) : buf).toString("utf-8");
  return {
    content:
      head +
      `\n\n> Peer note truncated. Use the \`memory\` tool's \`view\` ` +
      `command to read the full file at \`peers/${peerId}.md\`.`,
    truncated: true,
  };
}

function matchesQuery(a: AgentSummary, q: string): boolean {
  const needle = q.toLowerCase();
  return (
    a.name.toLowerCase().includes(needle) ||
    a.role.toLowerCase().includes(needle) ||
    a.id.toLowerCase().includes(needle)
  );
}

const TOOL_DESCRIPTION =
  "List your coworkers (other agents in this workforce). Each result " +
  "carries the peer's stable `id`, their display `name`, and their " +
  "`role` (a paragraph the peer's creator wrote describing what they " +
  "do, what they own, and where they redirect work). If you have a " +
  "peer note saved at `peers/<id>.md`, its body is returned " +
  "inline as `peer_note` — that's your lived experience with this " +
  "coworker (from prior delegations), distinct from the canonical role. " +
  "Use this tool when you're about to delegate a task and aren't sure " +
  "who the right assignee is. Pass `query` to narrow the result by " +
  "substring match over role/name/id.";

registry.register({
  name: "agent_list",
  toolset: "agents",
  description: TOOL_DESCRIPTION,
  parameters: z.object({
    query: z
      .string()
      .optional()
      .describe(
        "Optional substring filter (case-insensitive) over each agent's " +
          "role, name, or id."
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe("Max number of agents to return. Default 25."),
  }),
  emoji: "👥",
  parallelSafe: true,
  handler: async (args) => {
    if (!bindings) {
      return JSON.stringify({
        ok: false,
        error:
          "agent_list not initialized — AgentManager must call bindAgentTool().",
      });
    }
    const a = args as { query?: string; limit?: number };
    const callerId = getCurrentAgentId();
    if (!callerId) {
      return JSON.stringify({
        ok: false,
        error: "agent_list requires an active agent context.",
      });
    }

    const all = bindings.listAgents().filter((p) => p.id !== callerId);
    const filtered = a.query ? all.filter((p) => matchesQuery(p, a.query!)) : all;
    const limited = filtered.slice(0, a.limit ?? DEFAULT_LIMIT);

    const enriched = limited.map((p) => {
      const note = bindings!.peerNoteFor(callerId, p.id);
      const base = {
        id: p.id,
        name: p.name,
        role: p.role,
        instant_messages_enabled: p.instantMessagesEnabled ?? true,
      };
      if (!note) return base;
      const { content, truncated } = truncateNote(note.content, p.id);
      return {
        ...base,
        peer_note: {
          content,
          mtime: new Date(note.mtimeMs).toISOString(),
          ...(truncated ? { truncated: true } : {}),
        },
      };
    });

    return JSON.stringify({
      ok: true,
      count: enriched.length,
      total: filtered.length,
      agents: enriched,
    });
  },
});

const ASK_DESCRIPTION =
  "Ask a coworker agent a direct question and wait for its answer in this " +
  "same tool call. Use this for quick consultation where you need the " +
  "peer's result immediately. For durable delegated work, multi-turn work, " +
  "work with dependencies, or work the peer should own independently, use " +
  "`task_create` instead. Omit `session_id` to start a fresh peer session; " +
  "pass a `session_id` returned by a previous `agent_ask` call to continue " +
  "that same peer conversation.";

registry.register({
  name: "agent_ask",
  toolset: "agents",
  description: ASK_DESCRIPTION,
  parameters: z.object({
    agent_id: z
      .string()
      .min(1)
      .describe("Stable id of the coworker agent to ask."),
    message: z
      .string()
      .min(1)
      .max(20000)
      .describe("The question or request to send to the coworker."),
    session_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Session id returned by an earlier `agent_ask` call. Omit to create a fresh session."
      ),
    timeout_ms: z
      .number()
      .int()
      .min(AGENT_ASK_MIN_TIMEOUT_MS)
      .max(AGENT_ASK_MAX_TIMEOUT_MS)
      .optional()
      .describe(
        "Wall-clock cap for the peer turn. Default 300000, min 60000, max 900000."
      ),
  }),
  emoji: "💬",
  parallelSafe: false,
  handler: async (args) => {
    if (!askBindings) {
      return JSON.stringify({
        ok: false,
        error:
          "agent_ask not initialized — AgentManager must call bindAgentAsk().",
      });
    }
    const callerAgentId = getCurrentAgentId();
    const callerSessionId = getCurrentSessionId();
    if (!callerAgentId || !callerSessionId) {
      return JSON.stringify({
        ok: false,
        error:
          "agent_ask requires an active agent and session context (use during a turn).",
      });
    }

    const a = args as {
      agent_id: string;
      message: string;
      session_id?: string;
      timeout_ms?: number;
    };

    const result = await askBindings.ask({
      callerAgentId,
      callerSessionId,
      targetAgentId: a.agent_id,
      message: a.message,
      sessionId: a.session_id,
      timeoutMs: a.timeout_ms ?? AGENT_ASK_DEFAULT_TIMEOUT_MS,
    });
    return JSON.stringify(result);
  },
});
