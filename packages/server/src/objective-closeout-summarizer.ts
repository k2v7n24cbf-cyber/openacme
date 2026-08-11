import { withOpenAcmeSpan } from "@openacme/llm-provider";
import type { ObjectiveCloseoutPacket } from "./objective-closeout-watcher.js";

const DEFAULT_CLOSEOUT_BRIEF_OUTPUT_TOKENS = 600;
const DEFAULT_SERVICE_OUTPUT_SAFETY_CAP_TOKENS = 1_000;
const DEFAULT_SUMMARY_SAFETY_HEADROOM_TOKENS = 4_000;
const DEFAULT_SERVICE_INPUT_SAFETY_CAP_TOKENS = 32_000;
const DEFAULT_FALLBACK_MAX_SUMMARY_INPUT_CHARS = 32_000;
const DEFAULT_FALLBACK_MAX_COMPRESSION_INPUT_CHARS = 24_000;
const DEFAULT_MAX_COMMENT_CHUNK_CHARS = 12_000;
const DEFAULT_MAX_COMMENT_CHUNK_OVERLAP_CHARS = 500;
const DEFAULT_MAX_COMMENT_CHUNKS_PER_COMMENT = 8;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CloseoutSummaryBudgetInput {
  modelContextWindowTokens: number | null;
  modelMaxOutputTokens: number | null;
  configuredOutputTokens?: number | null;
  configuredInputTokens?: number | null;
  systemPromptBudgetTokens?: number;
  instructionBudgetTokens?: number;
  defaultCloseoutBriefOutputTokens?: number;
  serviceOutputSafetyCapTokens?: number;
  summarySafetyHeadroomTokens?: number;
  serviceInputSafetyCapTokens?: number;
  fallbackMaxSummaryInputChars?: number;
}

export interface CloseoutSummaryBudget {
  targetOutputTokens: number;
  maxInputTokens: number | null;
  maxInputChars: number;
}

export type ObjectiveSummaryModelCall =
  | {
      kind: "objective";
      input: PackedObjectiveSummaryInput;
      maxOutputTokens: number;
      sources: SummarySourceRef[];
      taskId?: undefined;
    }
  | {
      kind: "task_evidence";
      input: PackedTaskEvidenceInput;
      maxOutputTokens: number;
      sources: SummarySourceRef[];
      taskId: string;
    }
  | {
      kind: "comment_chunk";
      input: PackedCommentChunkInput;
      maxOutputTokens: number;
      sources: SummarySourceRef[];
      taskId: string;
    };

export interface SummarySourceRef {
  task_id: string;
  comment_id: string;
  chunk_index?: number;
  char_start?: number;
  char_end?: number;
}

export type ObjectiveSummaryModelResult = unknown;

export interface ObjectiveCloseoutSummarizerOptions {
  modelContextWindowTokens?: number | null;
  modelMaxOutputTokens?: number | null;
  configuredOutputTokens?: number | null;
  configuredInputTokens?: number | null;
  maxSummaryInputChars?: number;
  fallbackMaxCompressionInputChars?: number;
  maxCommentChunkChars?: number;
  maxCommentChunkOverlapChars?: number;
  maxCommentChunksPerComment?: number;
  timeoutMs?: number;
  callModel: (
    call: ObjectiveSummaryModelCall,
  ) => Promise<ObjectiveSummaryModelResult>;
}

export interface ObjectiveCloseoutSummaryResult {
  status: "ok" | "partial" | "failed";
  brief: unknown | null;
  packedInput: PackedObjectiveSummaryInput | null;
  failureReasons: string[];
  compressionUsed: boolean;
  inputTruncated: boolean;
}

export interface PackedObjectiveSummaryInput {
  objective: {
    id: string;
    title: string;
    status: string;
    description: string;
    closeout_prompt: string;
  };
  rollup: ObjectiveCloseoutPacket["rollup"];
  tasks: PackedObjectiveTask[];
  truncation: {
    input_truncated: boolean;
    reasons: string[];
  };
}

export interface PackedObjectiveTask {
  id: string;
  title: string;
  status: string;
  assignee: string;
  session_id: string | null;
  updated_at: string;
  closed_at: string | null;
  has_result_comment: boolean;
  comment_count: number;
  result_excerpt?: string;
  system_excerpt?: string;
  recent_comment_excerpts?: Array<{ kind: string | null; excerpt: string }>;
  compressed_evidence?: unknown;
}

export interface PackedTaskEvidenceInput {
  task: PackedObjectiveTask;
  evidence: Array<{ comment_id: string; text: string }>;
  chunk_summaries?: unknown[];
}

export interface PackedCommentChunkInput {
  task_id: string;
  comment_id: string;
  text: string;
  chunk_index: number;
  char_start: number;
  char_end: number;
}

export function deriveCloseoutSummaryBudget(
  input: CloseoutSummaryBudgetInput,
): CloseoutSummaryBudget {
  const defaultOutput =
    input.defaultCloseoutBriefOutputTokens ??
    DEFAULT_CLOSEOUT_BRIEF_OUTPUT_TOKENS;
  const outputCap =
    input.serviceOutputSafetyCapTokens ??
    DEFAULT_SERVICE_OUTPUT_SAFETY_CAP_TOKENS;
  const targetOutputTokens = Math.min(
    input.configuredOutputTokens ?? defaultOutput,
    input.modelMaxOutputTokens ?? Number.POSITIVE_INFINITY,
    outputCap,
  );

  if (input.modelContextWindowTokens == null) {
    return {
      targetOutputTokens,
      maxInputTokens: null,
      maxInputChars:
        input.fallbackMaxSummaryInputChars ??
        DEFAULT_FALLBACK_MAX_SUMMARY_INPUT_CHARS,
    };
  }

  const derived = Math.max(
    0,
    input.modelContextWindowTokens -
      (input.systemPromptBudgetTokens ?? 0) -
      (input.instructionBudgetTokens ?? 0) -
      targetOutputTokens -
      (input.summarySafetyHeadroomTokens ??
        DEFAULT_SUMMARY_SAFETY_HEADROOM_TOKENS),
  );
  const maxInputTokens = Math.min(
    input.configuredInputTokens ?? derived,
    input.serviceInputSafetyCapTokens ??
      DEFAULT_SERVICE_INPUT_SAFETY_CAP_TOKENS,
  );
  return {
    targetOutputTokens,
    maxInputTokens,
    maxInputChars: maxInputTokens * 4,
  };
}

export class ObjectiveCloseoutSummarizer {
  private readonly options: ObjectiveCloseoutSummarizerOptions;
  private readonly budget: CloseoutSummaryBudget;

  constructor(options: ObjectiveCloseoutSummarizerOptions) {
    this.options = options;
    this.budget = deriveCloseoutSummaryBudget({
      modelContextWindowTokens: options.modelContextWindowTokens ?? null,
      modelMaxOutputTokens: options.modelMaxOutputTokens ?? null,
      configuredOutputTokens: options.configuredOutputTokens,
      configuredInputTokens: options.configuredInputTokens,
      fallbackMaxSummaryInputChars: options.maxSummaryInputChars,
    });
  }

  async summarize(
    packet: ObjectiveCloseoutPacket,
  ): Promise<ObjectiveCloseoutSummaryResult> {
    return withOpenAcmeSpan(
      "objective.closeout.summarize",
      {
        "objective.id": packet.objective.id,
        "objective.status": packet.objective.status,
        "linked_task_count": packet.rollup.linked_task_count,
        "terminal_task_count": packet.rollup.terminal_task_count,
        "nonterminal_task_count": packet.rollup.nonterminal_task_count,
        "summary.target_output_tokens": this.budget.targetOutputTokens,
      },
      async (span) => {
        const result = await this.summarizePacket(packet);
        span.setAttributes({
          "objective.closeout.result": result.status,
          "summary.used": result.brief !== null,
          "summary.input_truncated": result.inputTruncated,
          "summary.compression_used": result.compressionUsed,
          "summary.failure_reason": result.failureReasons.join(","),
        });
        return result;
      },
    );
  }

  private async summarizePacket(
    packet: ObjectiveCloseoutPacket,
  ): Promise<ObjectiveCloseoutSummaryResult> {
    const failureReasons: string[] = [];
    const baseInput = packObjectiveInput(packet, new Map(), failureReasons);
    if (jsonSize(baseInput) <= this.maxSummaryInputChars) {
      return this.callObjective(baseInput, failureReasons, false, false);
    }

    const manifestOnly = packManifestOnly(packet, failureReasons);
    if (jsonSize(manifestOnly) > this.maxSummaryInputChars) {
      return failed(["input_budget_exceeded"], manifestOnly, false, true);
    }

    const compressed = new Map<string, unknown>();
    let compressionUsed = false;
    for (const task of packet.linked_tasks) {
      const evidence = taskEvidence(task);
      if (evidence.length === 0) continue;
      const evidenceSize = jsonSize(evidence);
      const taskContributesOverflow =
        (task.latest_result_comment_excerpt?.length ?? 0) +
          (task.latest_system_comment_excerpt?.length ?? 0) >
        0;
      if (!taskContributesOverflow) continue;

      try {
        compressionUsed = true;
        compressed.set(
          task.id,
          evidenceSize <= this.maxCompressionInputChars
            ? await this.compressTaskEvidence(task.id, evidence, [])
            : await this.compressChunkedTaskEvidence(
                task.id,
                evidence,
                failureReasons,
              ),
        );
      } catch {
        failureReasons.push("task_compression_failed");
      }

      const repacked = packObjectiveInput(packet, compressed, failureReasons);
      if (jsonSize(repacked) <= this.maxSummaryInputChars) {
        return this.callObjective(
          repacked,
          failureReasons,
          compressionUsed,
          false,
        );
      }
    }

    const trimmed = packObjectiveInput(packet, compressed, failureReasons, {
      dropBodies: true,
      dropRecent: true,
      shortenExcerpts: true,
    });
    if (jsonSize(trimmed) > this.maxSummaryInputChars) {
      return failed(
        ["input_budget_exceeded", ...failureReasons],
        manifestOnly,
        compressionUsed,
        true,
      );
    }
    return this.callObjective(trimmed, failureReasons, compressionUsed, true);
  }

  private async callObjective(
    input: PackedObjectiveSummaryInput,
    failureReasons: string[],
    compressionUsed: boolean,
    inputTruncated: boolean,
  ): Promise<ObjectiveCloseoutSummaryResult> {
    try {
      const brief = await withTimeout(
        this.options.callModel({
          kind: "objective",
          input,
          maxOutputTokens: this.budget.targetOutputTokens,
          sources: [],
        }),
        this.timeoutMs,
      );
      return {
        status: failureReasons.length > 0 ? "partial" : "ok",
        brief,
        packedInput: input,
        failureReasons,
        compressionUsed,
        inputTruncated,
      };
    } catch (error) {
      return failed(
        [isTimeout(error) ? "timeout" : "model_failed", ...failureReasons],
        input,
        compressionUsed,
        inputTruncated,
      );
    }
  }

  private async compressTaskEvidence(
    taskId: string,
    evidence: Array<{ comment_id: string; text: string }>,
    sources: SummarySourceRef[],
  ): Promise<unknown> {
    return withOpenAcmeSpan(
      "objective.closeout.compress_task_evidence",
      {
        "summary.compression_used": true,
        "summary.compression_chunked": false,
        "summary.evidence_items": evidence.length,
        "summary.source_count": sources.length,
      },
      () =>
        withTimeout(
          this.options.callModel({
            kind: "task_evidence",
            taskId,
            input: {
              task: evidenceTask(taskId),
              evidence,
            },
            maxOutputTokens: 400,
            sources,
          }),
          this.timeoutMs,
        ),
    );
  }

  private async compressChunkedTaskEvidence(
    taskId: string,
    evidence: Array<{ comment_id: string; text: string }>,
    failureReasons: string[],
  ): Promise<unknown> {
    return withOpenAcmeSpan(
      "objective.closeout.compress_task_evidence",
      {
        "summary.compression_used": true,
        "summary.compression_chunked": true,
        "summary.evidence_items": evidence.length,
      },
      async (span) => {
        const chunkSummaries: unknown[] = [];
        const sources: SummarySourceRef[] = [];
        let chunkBudgetExceeded = false;
        for (const item of evidence) {
          const chunks = chunkText(
            item.text,
            this.maxCommentChunkChars,
            this.maxCommentChunkOverlapChars,
            this.maxCommentChunksPerComment,
          );
          if (chunks.truncated) {
            chunkBudgetExceeded = true;
            failureReasons.push("comment_chunk_budget_exceeded");
          }
          for (const chunk of chunks.items) {
            const source = {
              task_id: taskId,
              comment_id: item.comment_id,
              chunk_index: chunk.index,
              char_start: chunk.start,
              char_end: chunk.end,
            };
            sources.push(source);
            chunkSummaries.push(
              await withTimeout(
                this.options.callModel({
                  kind: "comment_chunk",
                  taskId,
                  input: {
                    task_id: taskId,
                    comment_id: item.comment_id,
                    text: chunk.text,
                    chunk_index: chunk.index,
                    char_start: chunk.start,
                    char_end: chunk.end,
                  },
                  maxOutputTokens: 250,
                  sources: [source],
                }),
                this.timeoutMs,
              ),
            );
          }
        }
        span.setAttributes({
          "summary.chunk_count": chunkSummaries.length,
          "summary.source_count": sources.length,
          "summary.chunk_budget_exceeded": chunkBudgetExceeded,
        });
        return withTimeout(
          this.options.callModel({
            kind: "task_evidence",
            taskId,
            input: {
              task: evidenceTask(taskId),
              evidence: [],
              chunk_summaries: chunkSummaries,
            },
            maxOutputTokens: 400,
            sources,
          }),
          this.timeoutMs,
        );
      },
    );
  }

  private get maxSummaryInputChars(): number {
    return this.options.maxSummaryInputChars ?? this.budget.maxInputChars;
  }

  private get maxCompressionInputChars(): number {
    return (
      this.options.fallbackMaxCompressionInputChars ??
      DEFAULT_FALLBACK_MAX_COMPRESSION_INPUT_CHARS
    );
  }

  private get maxCommentChunkChars(): number {
    return this.options.maxCommentChunkChars ?? DEFAULT_MAX_COMMENT_CHUNK_CHARS;
  }

  private get maxCommentChunkOverlapChars(): number {
    return (
      this.options.maxCommentChunkOverlapChars ??
      DEFAULT_MAX_COMMENT_CHUNK_OVERLAP_CHARS
    );
  }

  private get maxCommentChunksPerComment(): number {
    return (
      this.options.maxCommentChunksPerComment ??
      DEFAULT_MAX_COMMENT_CHUNKS_PER_COMMENT
    );
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }
}

function packObjectiveInput(
  packet: ObjectiveCloseoutPacket,
  compressed: Map<string, unknown>,
  failureReasons: string[],
  opts: {
    dropBodies?: boolean;
    dropRecent?: boolean;
    shortenExcerpts?: boolean;
  } = {},
): PackedObjectiveSummaryInput {
  return {
    objective: {
      id: packet.objective.id,
      title: cap(packet.objective.title, 300),
      status: packet.objective.status,
      description: opts.dropBodies
        ? ""
        : cap(packet.objective.description, 1_200),
      closeout_prompt: cap(packet.objective.closeout_prompt, 800),
    },
    rollup: packet.rollup,
    tasks: packet.linked_tasks.map((task) => {
      const packed: PackedObjectiveTask = {
        id: task.id,
        title: cap(task.title, 300),
        status: task.status,
        assignee: task.assignee,
        session_id: task.session_id,
        updated_at: task.updated_at,
        closed_at: task.closed_at,
        has_result_comment: task.latest_result_comment_excerpt !== null,
        comment_count:
          task.latest_comment_excerpts.length +
          (task.latest_result_comment_excerpt ? 1 : 0) +
          (task.latest_system_comment_excerpt ? 1 : 0),
      };
      const compressedEvidence = compressed.get(task.id);
      if (compressedEvidence !== undefined) {
        packed.compressed_evidence = compressedEvidence;
        return packed;
      }
      if (task.latest_result_comment_excerpt) {
        packed.result_excerpt = cap(
          task.latest_result_comment_excerpt,
          opts.shortenExcerpts ? 500 : 2_500,
        );
      }
      if (task.latest_system_comment_excerpt) {
        packed.system_excerpt = cap(
          task.latest_system_comment_excerpt,
          opts.shortenExcerpts ? 400 : 1_200,
        );
      }
      if (!opts.dropRecent && task.latest_comment_excerpts.length > 0) {
        packed.recent_comment_excerpts = task.latest_comment_excerpts
          .slice(-3)
          .map((comment) => ({
            kind: comment.kind,
            excerpt: cap(comment.excerpt, 800),
          }));
      }
      return packed;
    }),
    truncation: {
      input_truncated: opts.dropBodies === true || opts.dropRecent === true,
      reasons: [...new Set(failureReasons)],
    },
  };
}

function packManifestOnly(
  packet: ObjectiveCloseoutPacket,
  failureReasons: string[],
): PackedObjectiveSummaryInput {
  return {
    objective: {
      id: packet.objective.id,
      title: cap(packet.objective.title, 160),
      status: packet.objective.status,
      description: "",
      closeout_prompt: "",
    },
    rollup: packet.rollup,
    tasks: packet.linked_tasks.map((task) => ({
      id: task.id,
      title: cap(task.title, 120),
      status: task.status,
      assignee: task.assignee,
      session_id: task.session_id,
      updated_at: task.updated_at,
      closed_at: task.closed_at,
      has_result_comment: task.latest_result_comment_excerpt !== null,
      comment_count:
        task.latest_comment_excerpts.length +
        (task.latest_result_comment_excerpt ? 1 : 0) +
        (task.latest_system_comment_excerpt ? 1 : 0),
    })),
    truncation: {
      input_truncated: true,
      reasons: [...new Set(["input_budget_exceeded", ...failureReasons])],
    },
  };
}

function taskEvidence(
  task: ObjectiveCloseoutPacket["linked_tasks"][number],
): Array<{ comment_id: string; text: string }> {
  const evidence: Array<{ comment_id: string; text: string }> = [];
  if (task.latest_result_comment_excerpt) {
    evidence.push({
      comment_id: "latest_result",
      text: task.latest_result_comment_excerpt,
    });
  }
  if (task.latest_system_comment_excerpt) {
    evidence.push({
      comment_id: "latest_system",
      text: task.latest_system_comment_excerpt,
    });
  }
  return evidence;
}

function evidenceTask(taskId: string): PackedObjectiveTask {
  return {
    id: taskId,
    title: "",
    status: "",
    assignee: "",
    session_id: null,
    updated_at: "",
    closed_at: null,
    has_result_comment: true,
    comment_count: 0,
  };
}

function chunkText(
  text: string,
  chunkChars: number,
  overlapChars: number,
  maxChunks: number,
): {
  items: Array<{ index: number; start: number; end: number; text: string }>;
  truncated: boolean;
} {
  const items: Array<{
    index: number;
    start: number;
    end: number;
    text: string;
  }> = [];
  let start = 0;
  while (start < text.length && items.length < maxChunks) {
    const end = Math.min(text.length, start + chunkChars);
    items.push({
      index: items.length,
      start,
      end,
      text: text.slice(start, end),
    });
    if (end >= text.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return { items, truncated: start < text.length };
}

function failed(
  reasons: string[],
  packedInput: PackedObjectiveSummaryInput | null,
  compressionUsed: boolean,
  inputTruncated: boolean,
): ObjectiveCloseoutSummaryResult {
  return {
    status: "failed",
    brief: null,
    packedInput,
    failureReasons: [...new Set(reasons)],
    compressionUsed,
    inputTruncated,
  };
}

function jsonSize(value: unknown): number {
  return JSON.stringify(value).length;
}

function cap(value: string, maxChars: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class TimeoutError extends Error {
  constructor() {
    super("objective closeout summary timed out");
    this.name = "TimeoutError";
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof TimeoutError;
}
