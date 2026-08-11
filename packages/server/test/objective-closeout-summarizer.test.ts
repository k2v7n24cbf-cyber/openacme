import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ObjectiveCloseoutSummarizer,
  deriveCloseoutSummaryBudget,
  type ObjectiveSummaryModelCall,
} from "../src/objective-closeout-summarizer.js";
import type { ObjectiveCloseoutPacket } from "../src/objective-closeout-watcher.js";

const telemetry = vi.hoisted(() => {
  type SpanRecord = {
    name: string;
    attributes: Record<string, unknown>;
    updates: Record<string, unknown>[];
    exceptions: unknown[];
  };
  const spans: SpanRecord[] = [];
  const withOpenAcmeSpanMock = vi.fn(
    async (
      name: string,
      attributes: Record<string, unknown>,
      fn: (span: {
        setAttributes: (attrs: Record<string, unknown>) => void;
        recordException: (error: unknown) => void;
      }) => unknown,
    ) => {
      const record: SpanRecord = {
        name,
        attributes,
        updates: [],
        exceptions: [],
      };
      spans.push(record);
      return await fn({
        setAttributes: (attrs) => record.updates.push(attrs),
        recordException: (error) => record.exceptions.push(error),
      });
    },
  );
  return { spans, withOpenAcmeSpanMock };
});

vi.mock("@openacme/llm-provider", () => ({
  withOpenAcmeSpan: telemetry.withOpenAcmeSpanMock,
}));

function packet(
  over: Partial<ObjectiveCloseoutPacket> = {},
): ObjectiveCloseoutPacket {
  return {
    objective: {
      id: "objective-1",
      title: "Ship objective",
      description: "Objective description",
      closeout_prompt: "Check deliverable quality.",
      status: "ready_for_closeout",
    },
    rollup: {
      linked_task_count: 1,
      terminal_task_count: 1,
      nonterminal_task_count: 0,
    },
    linked_tasks: [
      {
        id: "1",
        title: "Implement",
        status: "done",
        assignee: "owner",
        session_id: "session-1",
        updated_at: "2026-08-11T00:00:00.000Z",
        closed_at: "2026-08-11T00:00:00.000Z",
        latest_result_comment_excerpt: "Implemented all requested behavior.",
        latest_system_comment_excerpt: null,
        latest_comment_excerpts: [],
      },
    ],
    ...over,
  };
}

function task(
  id: string,
  over: Partial<ObjectiveCloseoutPacket["linked_tasks"][number]> = {},
) {
  return {
    id,
    title: `Task ${id}`,
    status: "done",
    assignee: "owner",
    session_id: "session-1",
    updated_at: "2026-08-11T00:00:00.000Z",
    closed_at: "2026-08-11T00:00:00.000Z",
    latest_result_comment_excerpt: `result ${id}`,
    latest_system_comment_excerpt: null,
    latest_comment_excerpts: [],
    ...over,
  };
}

describe("deriveCloseoutSummaryBudget", () => {
  it("selects output budget from override/default, model max output, and service cap", () => {
    expect(
      deriveCloseoutSummaryBudget({
        modelContextWindowTokens: 20_000,
        modelMaxOutputTokens: 2_000,
        configuredOutputTokens: 1_500,
        serviceOutputSafetyCapTokens: 1_000,
      }).targetOutputTokens,
    ).toBe(1_000);

    expect(
      deriveCloseoutSummaryBudget({
        modelContextWindowTokens: 20_000,
        modelMaxOutputTokens: 500,
      }).targetOutputTokens,
    ).toBe(500);
  });

  it("derives input budget from context minus prompt/output/headroom with char fallback", () => {
    const budget = deriveCloseoutSummaryBudget({
      modelContextWindowTokens: 10_000,
      modelMaxOutputTokens: 900,
      systemPromptBudgetTokens: 1_000,
      instructionBudgetTokens: 500,
      summarySafetyHeadroomTokens: 2_000,
    });

    expect(budget.maxInputTokens).toBe(5_900);
    expect(budget.maxInputChars).toBe(23_600);

    const fallback = deriveCloseoutSummaryBudget({
      modelContextWindowTokens: null,
      modelMaxOutputTokens: null,
      fallbackMaxSummaryInputChars: 12_000,
    });
    expect(fallback.maxInputTokens).toBeNull();
    expect(fallback.maxInputChars).toBe(12_000);
  });
});

describe("ObjectiveCloseoutSummarizer", () => {
  beforeEach(() => {
    telemetry.spans.length = 0;
    telemetry.withOpenAcmeSpanMock.mockClear();
  });

  it("uses a single objective summary call when packed input fits", async () => {
    const calls: ObjectiveSummaryModelCall[] = [];
    const summarizer = new ObjectiveCloseoutSummarizer({
      modelContextWindowTokens: 20_000,
      modelMaxOutputTokens: 1_000,
      callModel: async (call) => {
        calls.push(call);
        return {
          task_outcomes: [],
          objective_risks: [],
          suggested_owner_action: "close_completed",
          rationale: "Looks complete.",
        };
      },
    });

    const result = await summarizer.summarize(packet());

    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe("objective");
    expect(calls[0]!.maxOutputTokens).toBe(600);
    expect(calls[0]!.input).toMatchObject({
      objective: { id: "objective-1" },
      tasks: [
        { id: "1", result_excerpt: "Implemented all requested behavior." },
      ],
    });
    const span = telemetry.spans.find(
      (record) => record.name === "objective.closeout.summarize",
    );
    expect(span?.attributes).toMatchObject({
      "objective.id": "objective-1",
      "objective.status": "ready_for_closeout",
      "linked_task_count": 1,
      "summary.target_output_tokens": 600,
    });
    expect(span?.updates).toContainEqual(
      expect.objectContaining({
        "objective.closeout.result": "ok",
        "summary.used": true,
        "summary.input_truncated": false,
        "summary.compression_used": false,
      }),
    );
  });

  it("compresses oversized task evidence before the objective summary", async () => {
    const calls: ObjectiveSummaryModelCall[] = [];
    const summarizer = new ObjectiveCloseoutSummarizer({
      maxSummaryInputChars: 1_500,
      fallbackMaxCompressionInputChars: 10_000,
      callModel: async (call) => {
        calls.push(call);
        if (call.kind === "task_evidence") {
          return {
            task_id: call.taskId,
            comment_sources: [],
            claimed_result: "compressed task evidence",
            important_evidence: [],
            warnings: [],
            unresolved_notes: [],
            possible_mismatch_with_task_request: null,
            truncation_notes: [],
          };
        }
        return {
          task_outcomes: [
            { task_id: "1", claimed_result: "compressed task evidence" },
          ],
          objective_risks: [],
          suggested_owner_action: "close_completed",
          rationale: "Compressed evidence is enough.",
        };
      },
    });

    const result = await summarizer.summarize(
      packet({
        linked_tasks: [
          task("1", {
            latest_result_comment_excerpt: "R".repeat(4_000),
            latest_system_comment_excerpt: "S".repeat(2_000),
          }),
        ],
      }),
    );

    expect(result.status).toBe("ok");
    expect(calls.map((call) => call.kind)).toEqual([
      "task_evidence",
      "objective",
    ]);
    expect(calls[1]!.input).toMatchObject({
      tasks: [{ id: "1", compressed_evidence: expect.any(Object) }],
    });
    const compressionSpan = telemetry.spans.find(
      (record) => record.name === "objective.closeout.compress_task_evidence",
    );
    expect(compressionSpan?.attributes).toMatchObject({
      "summary.compression_used": true,
      "summary.compression_chunked": false,
      "summary.evidence_items": 2,
    });
  });

  it("chunks oversized comments deterministically and records chunk cap overflow", async () => {
    const calls: ObjectiveSummaryModelCall[] = [];
    const summarizer = new ObjectiveCloseoutSummarizer({
      maxSummaryInputChars: 1_000,
      fallbackMaxCompressionInputChars: 500,
      maxCommentChunkChars: 100,
      maxCommentChunkOverlapChars: 10,
      maxCommentChunksPerComment: 2,
      callModel: async (call) => {
        calls.push(call);
        if (call.kind === "comment_chunk") {
          return {
            task_id: call.taskId,
            comment_sources: call.sources,
            claimed_result: "chunk summary",
            important_evidence: [],
            warnings: [],
            unresolved_notes: [],
            possible_mismatch_with_task_request: null,
            truncation_notes: [],
          };
        }
        if (call.kind === "task_evidence") {
          return {
            task_id: call.taskId,
            comment_sources: call.sources,
            claimed_result: "merged chunks",
            important_evidence: [],
            warnings: [],
            unresolved_notes: [],
            possible_mismatch_with_task_request: null,
            truncation_notes: ["comment_chunk_budget_exceeded"],
          };
        }
        return {
          task_outcomes: [],
          objective_risks: [],
          suggested_owner_action: "create_followup",
          rationale: "Chunked evidence was truncated.",
        };
      },
    });

    const result = await summarizer.summarize(
      packet({
        linked_tasks: [
          task("1", {
            latest_result_comment_excerpt: "A".repeat(800),
          }),
        ],
      }),
    );

    expect(calls.filter((call) => call.kind === "comment_chunk")).toHaveLength(
      2,
    );
    expect(calls[0]!.sources[0]).toMatchObject({
      task_id: "1",
      comment_id: "latest_result",
      chunk_index: 0,
      char_start: 0,
    });
    expect(result.status).toBe("partial");
    expect(result.failureReasons).toContain("comment_chunk_budget_exceeded");
  });

  it("skips AI when metadata plus manifest exceeds budget", async () => {
    const callModel = vi.fn();
    const summarizer = new ObjectiveCloseoutSummarizer({
      maxSummaryInputChars: 200,
      callModel,
    });

    const result = await summarizer.summarize(
      packet({
        objective: {
          id: "objective-large",
          title: "T".repeat(500),
          description: "D".repeat(500),
          closeout_prompt: "P".repeat(500),
          status: "ready_for_closeout",
        },
        linked_tasks: Array.from({ length: 20 }, (_, i) =>
          task(String(i + 1), { title: "X".repeat(200) }),
        ),
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.failureReasons).toContain("input_budget_exceeded");
    expect(callModel).not.toHaveBeenCalled();
  });

  it("returns deterministic fallback on model failure or timeout", async () => {
    const failing = new ObjectiveCloseoutSummarizer({
      callModel: async () => {
        throw new Error("model unavailable");
      },
    });
    await expect(failing.summarize(packet())).resolves.toMatchObject({
      status: "failed",
      failureReasons: ["model_failed"],
      brief: null,
    });

    const timeout = new ObjectiveCloseoutSummarizer({
      timeoutMs: 1,
      callModel: () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ suggested_owner_action: "close_completed" }),
            50,
          ),
        ),
    });
    await expect(timeout.summarize(packet())).resolves.toMatchObject({
      status: "failed",
      failureReasons: ["timeout"],
      brief: null,
    });
  });
});
