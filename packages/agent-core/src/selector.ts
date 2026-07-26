/**
 * Recall selector. Picks ≤5 memories from the agent's dir for a given
 * trigger text. Routes through `runSubagent({mode:"structured"})` — one
 * `generateObject` call against the parent's model. Cross-provider:
 * fails closed (returns `[]`) on providers without structured-output.
 */

import { z } from "zod";
import { createLogger } from "@openacme/config/logger";
import {
  formatMemoryManifest,
  scanMemoryFiles,
  type MemoryHeader,
} from "@openacme/memory";
import type { Agent } from "./agent.js";
import { extractErrorText } from "./error-classifier.js";
import { runSubagent } from "./subagent.js";

const log = createLogger("agent-core.selector");

export interface RelevantMemory {
  path: string;
  mtimeMs: number;
}

const MAX_SELECTED = 5;
const SELECTOR_TIMEOUT_MS = 30_000;
const SELECTOR_MAX_OUTPUT_TOKENS = 256;
const TIMELINE_ERROR_MAX_CHARS = 4096;

function truncateTimelineError(value: string | undefined): string | null {
  if (!value) return null;
  return value.length > TIMELINE_ERROR_MAX_CHARS
    ? value.slice(0, TIMELINE_ERROR_MAX_CHARS)
    : value;
}

// Verbatim from Claude Code; trained-on wording.
const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to the assistant as it processes a query. You will be given the query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to the assistant as it processes the query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (the assistant is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.
`;

const SelectionSchema = z.object({
  selected_memories: z.array(z.string()),
});

export interface FindRelevantMemoriesArgs {
  parent: Agent;
  /** Session the recall is for — usage-ledger attribution when present. */
  sessionId?: string;
  /** Work-item description; trigger source is opaque. */
  triggerText: string;
  memoryDir: string;
  /** Selector suppresses reference-doc hits for these tools. */
  recentTools?: readonly string[];
  /** Filtered out before the model call. */
  alreadySurfaced?: ReadonlySet<string>;
  signal?: AbortSignal;
}

export async function findRelevantMemories(
  args: FindRelevantMemoriesArgs
): Promise<RelevantMemory[]> {
  const startedAt = Date.now();
  const report = (
    eventType: string,
    status: string,
    payload: Record<string, unknown>,
    durationMs?: number
  ) => {
    if (!args.sessionId) return;
    args.parent.reportTimelineEvent({
      sessionId: args.sessionId,
      agentId: args.parent.config.id,
      eventType,
      source: "agent",
      status,
      ...(durationMs !== undefined ? { durationMs } : {}),
      payload,
    });
  };

  const surfaced = args.alreadySurfaced ?? new Set<string>();
  report("session.memory.selection.started", "running", {
    recentToolCount: args.recentTools?.length ?? 0,
    alreadySurfacedCount: surfaced.size,
    triggerTextChars: args.triggerText.length,
  });

  let all: MemoryHeader[];
  try {
    all = await scanMemoryFiles(args.memoryDir, args.signal);
  } catch (e) {
    report(
      "session.memory.selection.failed",
      "error",
      {
        phase: "scan",
        error: truncateTimelineError(extractErrorText(e)),
      },
      Date.now() - startedAt
    );
    throw e;
  }

  const candidates = all.filter((m) => !surfaced.has(m.filePath));
  if (candidates.length === 0) {
    report(
      "session.memory.selection.skipped",
      "skipped",
      {
        reason: "no_candidates",
        memoryFileCount: all.length,
        alreadySurfacedCount: surfaced.size,
      },
      Date.now() - startedAt
    );
    return [];
  }

  const selection = await selectFilenames(candidates, args);
  if (selection.status !== "completed") {
    report(
      "session.memory.selection.failed",
      selection.status === "timeout" || selection.status === "aborted"
        ? selection.status
        : "error",
      {
        selectorStatus: selection.status,
        candidateCount: candidates.length,
        error: truncateTimelineError(selection.error),
      },
      Date.now() - startedAt
    );
    return [];
  }
  const byName = new Map(candidates.map((m) => [m.filename, m]));
  const out: RelevantMemory[] = [];
  for (const name of selection.names) {
    const hit = byName.get(name);
    if (hit) out.push({ path: hit.filePath, mtimeMs: hit.mtimeMs });
    if (out.length >= MAX_SELECTED) break;
  }
  report(
    "session.memory.selection.finished",
    "ok",
    {
      candidateCount: candidates.length,
      selectedNameCount: selection.names.length,
      selectedCount: out.length,
    },
    Date.now() - startedAt
  );
  return out;
}

type FilenameSelection =
  | { status: "completed"; names: string[] }
  | { status: "failed" | "timeout" | "aborted"; names: []; error?: string };

async function selectFilenames(
  candidates: MemoryHeader[],
  args: FindRelevantMemoriesArgs
): Promise<FilenameSelection> {
  const validNames = new Set(candidates.map((m) => m.filename));
  const manifest = formatMemoryManifest(candidates);
  const toolsSection =
    args.recentTools && args.recentTools.length > 0
      ? `\n\nRecently used tools: ${args.recentTools.join(", ")}`
      : "";
  const userMessage = `Query: ${args.triggerText}\n\nAvailable memories:\n${manifest}${toolsSection}`;

  const result = await runSubagent({
    mode: "structured",
    parent: args.parent,
    system: SELECT_MEMORIES_SYSTEM_PROMPT,
    user: userMessage,
    schema: SelectionSchema,
    maxOutputTokens: SELECTOR_MAX_OUTPUT_TOKENS,
    timeoutMs: SELECTOR_TIMEOUT_MS,
    abortSignal: args.signal,
    ...(args.sessionId
      ? { usage: { kind: "selector" as const, sessionId: args.sessionId } }
      : {}),
  });

  if (result.status !== "completed" || !result.object) {
    if (result.status === "failed") {
      log.warn(
        { agentId: args.parent.config.id, error: result.error ?? "unknown" },
        "memory.selector failed"
      );
    }
    return {
      status: result.status,
      names: [],
      error: result.error,
    };
  }
  return {
    status: "completed",
    names: result.object.selected_memories.filter((n) => validNames.has(n)),
  };
}
