import { generateObject, streamObject } from "ai";
import { z } from "zod";
import type { ModelResolver } from "@openacme/agent-core";
import type { AgentBehavior, ModelConfig } from "@openacme/config";
import { lookupModelMetadata } from "@openacme/config";
import { getEffectiveContextWindow, getModel } from "@openacme/llm-provider";
import {
  ObjectiveCloseoutSummarizer,
  type ObjectiveSummaryModelCall,
  type ObjectiveSummaryModelResult,
} from "./objective-closeout-summarizer.js";

const MAX_OWNER_BRIEF_OUTPUT_TOKENS = 600;

const CommentChunkBriefSchema = z.object({
  summary: z.string(),
  notable_claims: z.array(z.string()),
  warnings: z.array(z.string()),
  open_questions: z.array(z.string()),
});

const TaskEvidenceBriefSchema = z.object({
  task_id: z.string(),
  claimed_result: z.string(),
  important_evidence: z.array(z.string()),
  warnings: z.array(z.string()),
  unresolved_notes: z.array(z.string()),
  possible_mismatch_with_task_request: z.string().nullable(),
  truncation_notes: z.array(z.string()),
});

const ObjectiveCloseoutBriefSchema = z.object({
  objective_completion_assessment: z.enum([
    "appears_complete",
    "needs_follow_up",
    "needs_rerun",
    "unclear",
  ]),
  suggested_owner_action: z.enum([
    "close_completed",
    "add_followup_task",
    "rerun_task",
    "mark_failed",
    "ask_user",
    "inspect_manually",
  ]),
  confidence: z.enum(["high", "medium", "low"]),
  task_outcomes: z
    .array(
      z.object({
        task_id: z.string(),
        status: z.string(),
        claimed_result: z.string(),
        verification_note: z.string(),
        concerns: z.array(z.string()),
      }),
    ),
  warnings: z.array(z.string()),
  notices: z.array(z.string()),
  recommended_follow_up: z.array(z.string()),
  rationale: z.string(),
});

export function createObjectiveCloseoutSummarizer(input: {
  model: ModelConfig;
  behavior: AgentBehavior;
  resolveModel?: ModelResolver;
}): ObjectiveCloseoutSummarizer {
  const modelContextWindowTokens = getEffectiveContextWindow(input.model);
  const metadata = lookupModelMetadata(input.model);
  const resolveModel = input.resolveModel ?? getModel;

  return new ObjectiveCloseoutSummarizer({
    modelContextWindowTokens,
    modelMaxOutputTokens: metadata.maxOutputTokens ?? null,
    configuredOutputTokens: Math.min(
      input.behavior.maxOutputTokens,
      MAX_OWNER_BRIEF_OUTPUT_TOKENS,
    ),
    configuredInputTokens:
      modelContextWindowTokens == null
        ? null
        : Math.floor(modelContextWindowTokens * 0.2),
    callModel: async (call) =>
      callObjectiveCloseoutModel({
        call,
        model: input.model,
        resolveModel,
      }),
  });
}

async function callObjectiveCloseoutModel(input: {
  call: ObjectiveSummaryModelCall;
  model: ModelConfig;
  resolveModel: ModelResolver;
}): Promise<ObjectiveSummaryModelResult> {
  const system = systemPrompt(input.call.kind);
  const schema =
    input.call.kind === "objective"
      ? ObjectiveCloseoutBriefSchema
      : input.call.kind === "task_evidence"
        ? TaskEvidenceBriefSchema
        : CommentChunkBriefSchema;

  const request = {
    model: input.resolveModel(input.model),
    system,
    schema,
    messages: [
      {
        role: "user" as const,
        content: JSON.stringify(input.call.input),
      },
    ],
    maxOutputTokens: input.call.maxOutputTokens,
  };
  if (usesStreamingStructuredOutput(input.model)) {
    const result = streamObject(request);
    const streamFinished = drainStream(result.fullStream);
    try {
      return await result.object;
    } finally {
      await streamFinished.catch(() => {
        // The object promise carries the meaningful model/validation failure.
      });
    }
  }

  const result = await generateObject(request);
  return result.object;
}

function systemPrompt(kind: ObjectiveSummaryModelCall["kind"]): string {
  if (kind === "comment_chunk") {
    return [
      "You summarize one large task comment chunk for objective closeout.",
      "Preserve concrete deliverables, warnings, failures, caveats, and open questions.",
      "Do not invent completion. Keep the result compact.",
    ].join("\n");
  }
  if (kind === "task_evidence") {
    return [
      "You compress task evidence for objective closeout.",
      "Extract what the task claims was delivered, evidence that supports it, warnings/notices, unresolved notes, and possible mismatch with the task title/request.",
      "Be skeptical and concise. Do not mark the task complete just because its status is terminal.",
    ].join("\n");
  }
  return [
    "You are preparing a compact objective closeout brief for the objective owner agent.",
    "Compare the objective, closeout prompt, task titles, terminal statuses, result comments, system comments, and compressed evidence.",
    "Your job is not to close the objective. Recommend what the owner should do next.",
    "Flag mismatches, missing result evidence, warnings/notices, partial delivery, and tasks that appear done but did not deliver the requested outcome.",
    "Use the same language as the objective/task content when obvious; otherwise use English.",
    "Keep the JSON concise enough to fit in an agent inbox notice.",
  ].join("\n");
}

function usesStreamingStructuredOutput(model: {
  provider?: string;
  auth?: string;
}): boolean {
  return model.provider === "openai" && model.auth === "oauth";
}

async function drainStream(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    // Draining drives the SDK stream pipeline so final object promise resolves.
  }
}
