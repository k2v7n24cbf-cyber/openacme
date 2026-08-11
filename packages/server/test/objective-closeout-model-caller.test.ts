import { describe, expect, it, vi, beforeEach } from "vitest";
import { createObjectiveCloseoutSummarizer } from "../src/objective-closeout-model-caller.js";
import type { ObjectiveCloseoutPacket } from "../src/objective-closeout-watcher.js";

const ai = vi.hoisted(() => ({
  generateObject: vi.fn(),
  streamObject: vi.fn(),
}));

vi.mock("ai", () => ({
  generateObject: ai.generateObject,
  streamObject: ai.streamObject,
}));

vi.mock("@openacme/llm-provider", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@openacme/llm-provider")>();
  return {
    ...actual,
    getModel: vi.fn(() => ({ provider: "mock" })),
  };
});

function packet(): ObjectiveCloseoutPacket {
  return {
    objective: {
      id: "objective-1",
      title: "Ship release",
      description: "Release safely.",
      closeout_prompt: "Check warnings before closing.",
      status: "waiting_on_tasks",
    },
    rollup: {
      linked_task_count: 1,
      terminal_task_count: 1,
      nonterminal_task_count: 0,
    },
    linked_tasks: [
      {
        id: "1",
        title: "Validate",
        status: "done",
        assignee: "owner",
        session_id: "session-1",
        updated_at: "2026-08-11T00:00:00.000Z",
        closed_at: "2026-08-11T00:00:00.000Z",
        latest_result_comment_excerpt: "Validated happy path only.",
        latest_system_comment_excerpt: "Warning: rollback not validated.",
        latest_comment_excerpts: [],
      },
    ],
  };
}

function brief(action = "add_followup_task") {
  return {
    objective_completion_assessment: "needs_follow_up",
    suggested_owner_action: action,
    confidence: "high",
    task_outcomes: [
      {
        task_id: "1",
        status: "done",
        claimed_result: "Validated happy path only.",
        verification_note: "Rollback is missing.",
        concerns: ["rollback not validated"],
      },
    ],
    warnings: ["rollback not validated"],
    notices: [],
    recommended_follow_up: ["validate rollback"],
    rationale: "Terminal task still has missing evidence.",
  };
}

describe("createObjectiveCloseoutSummarizer", () => {
  beforeEach(() => {
    ai.generateObject.mockReset();
    ai.streamObject.mockReset();
  });

  it("uses streaming structured output for OpenAI OAuth models", async () => {
    ai.streamObject.mockReturnValue({
      fullStream: (async function* () {
        yield {};
      })(),
      object: Promise.resolve(brief()),
    });
    const resolveModel = vi.fn(() => ({ provider: "mock-model" }) as never);
    const summarizer = createObjectiveCloseoutSummarizer({
      model: { provider: "openai", model: "gpt-5.5", auth: "oauth" },
      behavior: { maxOutputTokens: 16_384 } as never,
      resolveModel,
    });

    const result = await summarizer.summarize(packet());

    expect(result.status).toBe("ok");
    expect(result.brief).toMatchObject({
      suggested_owner_action: "add_followup_task",
    });
    expect(ai.streamObject).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 600 }),
    );
    expect(ai.generateObject).not.toHaveBeenCalled();
  });

  it("uses non-streaming structured output for non-OAuth models", async () => {
    ai.generateObject.mockResolvedValue({ object: brief("close_completed") });
    const resolveModel = vi.fn(() => ({ provider: "mock-model" }) as never);
    const summarizer = createObjectiveCloseoutSummarizer({
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      behavior: { maxOutputTokens: 16_384 } as never,
      resolveModel,
    });

    const result = await summarizer.summarize(packet());

    expect(result.status).toBe("ok");
    expect(result.brief).toMatchObject({
      suggested_owner_action: "close_completed",
    });
    expect(ai.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 600 }),
    );
    expect(ai.streamObject).not.toHaveBeenCalled();
  });
});
