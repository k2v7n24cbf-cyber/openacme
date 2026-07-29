import { describe, it, expect, beforeEach } from "vitest";
import { registry } from "../src/registry.js";
import {
  bindAgentAsk,
  bindAgentTool,
  type AgentAskResult,
  type AgentSummary,
  type PeerNote,
} from "../src/builtins/agent.js";
import { toolCallContext } from "../src/session-context.js";

interface ListResult {
  ok: boolean;
  count: number;
  total: number;
  agents: Array<{
    id: string;
    name: string;
    role: string;
    instant_messages_enabled?: boolean;
    peer_note?: {
      content: string;
      mtime: string;
      truncated?: boolean;
    };
  }>;
  error?: string;
}

async function runList(
  args: Record<string, unknown>,
  callerAgentId?: string
): Promise<ListResult> {
  const tool = registry.get("agent_list");
  if (!tool) throw new Error("agent_list not registered");
  const exec = () => tool.handler(args);
  const out = callerAgentId
    ? await toolCallContext.run({ agentId: callerAgentId }, exec)
    : await exec();
  return JSON.parse(out) as ListResult;
}

async function runAsk(
  args: Record<string, unknown>,
  callerAgentId?: string,
  callerSessionId = "caller-session"
): Promise<AgentAskResult> {
  const tool = registry.get("agent_ask");
  if (!tool) throw new Error("agent_ask not registered");
  const exec = () => tool.handler(args);
  const out = callerAgentId
    ? await toolCallContext.run(
        {
          agentId: callerAgentId,
          sessionId: callerSessionId,
          workspaceDir: "/tmp/openacme-test",
        },
        exec
      )
    : await exec();
  return JSON.parse(out) as AgentAskResult;
}

const SAMPLE: AgentSummary[] = [
  { id: "alice", name: "Alice", role: "Researcher — owns citation gathering." },
  {
    id: "bob",
    name: "Bob",
    role: "Backend engineer — owns auth + billing APIs.",
    instantMessagesEnabled: false,
  },
  { id: "carol", name: "Carol", role: "Ops — owns deploys, oncall." },
];

describe("agent_list", () => {
  beforeEach(() => {
    bindAgentTool({
      listAgents: () => SAMPLE,
      peerNoteFor: () => null,
    });
  });

  it("excludes the caller from the result", async () => {
    const res = await runList({}, "alice");
    expect(res.ok).toBe(true);
    expect(res.agents.map((a) => a.id)).toEqual(["bob", "carol"]);
    expect(res.count).toBe(2);
    expect(res.total).toBe(2);
  });

  it("filters by query over role/name/id (case-insensitive)", async () => {
    const res = await runList({ query: "AUTH" }, "alice");
    expect(res.agents.map((a) => a.id)).toEqual(["bob"]);
  });

  it("query matches the id substring too", async () => {
    const res = await runList({ query: "carol" }, "alice");
    expect(res.agents.map((a) => a.id)).toEqual(["carol"]);
  });

  it("surfaces whether each coworker accepts instant messages", async () => {
    const res = await runList({}, "alice");
    const bob = res.agents.find((a) => a.id === "bob");
    const carol = res.agents.find((a) => a.id === "carol");
    expect(bob?.instant_messages_enabled).toBe(false);
    expect(carol?.instant_messages_enabled).toBe(true);
  });

  it("returns total separate from count when limit applies", async () => {
    const res = await runList({ limit: 1 }, "alice");
    expect(res.count).toBe(1);
    expect(res.total).toBe(2);
  });

  it("inlines peer_note when one exists for the caller", async () => {
    bindAgentTool({
      listAgents: () => SAMPLE,
      peerNoteFor: (caller, peer): PeerNote | null => {
        if (caller === "alice" && peer === "bob") {
          return { content: "Bob is fast on auth; slow on infra.", mtimeMs: 1_000_000 };
        }
        return null;
      },
    });
    const res = await runList({}, "alice");
    const bob = res.agents.find((a) => a.id === "bob");
    const carol = res.agents.find((a) => a.id === "carol");
    expect(bob?.peer_note?.content).toContain("fast on auth");
    expect(bob?.peer_note?.truncated).toBeUndefined();
    expect(carol?.peer_note).toBeUndefined();
  });

  it("truncates peer_note bodies over 2KB and includes the peer id in the hint", async () => {
    const huge = "x".repeat(3000) + "\n";
    bindAgentTool({
      listAgents: () => SAMPLE,
      peerNoteFor: () => ({ content: huge, mtimeMs: 0 }),
    });
    const res = await runList({}, "alice");
    const bob = res.agents.find((a) => a.id === "bob");
    expect(bob?.peer_note?.truncated).toBe(true);
    expect(bob?.peer_note?.content).toContain("peers/bob.md");
    // content is bounded; the suffix adds a small hint but the original
    // 3000-byte payload should be cut down.
    expect(bob!.peer_note!.content.length).toBeLessThan(huge.length);
  });

  it("errors cleanly when no agent context is present", async () => {
    const res = await runList({});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/active agent context/);
  });

  it("respects the binding's id rejection — defense-in-depth path", async () => {
    // The agentStore validates ids on upsert with SAFE_ID, so a
    // traversal-shaped id never reaches the real binding. Test the
    // *contract*: if a binding rejects an id (its job is to reject
    // anything that doesn't match the SAFE_ID shape), the tool surfaces
    // the entry from listAgents but omits peer_note. No throw, no leak.
    const PEER_ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
    bindAgentTool({
      listAgents: () => [
        { id: "../../../etc/passwd", name: "Sketchy", role: "synthetic" },
        ...SAMPLE,
      ],
      peerNoteFor: (_caller, peer) => {
        if (!PEER_ID_SAFE.test(peer)) return null;
        return { content: "should never appear for the bad id", mtimeMs: 0 };
      },
    });
    const res = await runList({}, "alice");
    const sketchy = res.agents.find((a) => a.id === "../../../etc/passwd");
    expect(sketchy).toBeDefined();
    expect(sketchy?.peer_note).toBeUndefined();
  });
});

describe("agent_ask", () => {
  it("passes active caller context and arguments to the runtime binding", async () => {
    bindAgentAsk({
      ask: async (request) => ({
        ok: true,
        target_agent_id: request.targetAgentId,
        session_id: request.sessionId ?? "fresh-peer-session",
        new_session: request.sessionId === undefined,
        user_message_id: "u1",
        assistant_message_id: "a1",
        response: `${request.callerAgentId}:${request.callerSessionId}:${request.message}:${request.timeoutMs}`,
        assistant_message: {
          role: "assistant",
          parts: [{ type: "text", text: "ok" }],
        },
      }),
    });

    const res = await runAsk(
      {
        agent_id: "bob",
        message: "check this",
        session_id: "prior-peer-session",
        timeout_ms: 60000,
      },
      "alice",
      "alice-session"
    );

    expect(res.ok).toBe(true);
    expect(res.target_agent_id).toBe("bob");
    expect(res.session_id).toBe("prior-peer-session");
    expect(res.response).toBe("alice:alice-session:check this:60000");
  });

  it("defaults timeout and reports missing active context cleanly", async () => {
    bindAgentAsk({
      ask: async (request) => ({
        ok: true,
        response: String(request.timeoutMs),
      }),
    });

    const ok = await runAsk({ agent_id: "bob", message: "hi" }, "alice");
    expect(ok.response).toBe("300000");

    const missing = await runAsk({ agent_id: "bob", message: "hi" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/active agent and session context/);
  });
});
