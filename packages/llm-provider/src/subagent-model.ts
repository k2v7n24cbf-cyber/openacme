import type { ModelConfig } from "@openacme/config";

/**
 * Cheap tier per provider for auxiliary subagent jobs (memory extractor,
 * title, recall selector, memory flush). Platform-set, not user-configurable:
 * these are skim/bookkeeping jobs where frontier quality is wasted and the
 * cost compounds per turn per agent. Determinism matters — a stable id keeps
 * the job's prompt-cache chain warm across fires.
 */
const CHEAP_MODEL_BY_PROVIDER: Record<string, string> = {
  anthropic: "claude-haiku-4-5",
  // Claude-family id so the OpenRouter wire-level cache injection still applies.
  openrouter: "anthropic/claude-haiku-4.5",
  // ChatGPT OAuth rejects gpt-5.2 for some accounts; keep aux jobs on the
  // supported default instead of downgrading them into a 400.
  openai: "gpt-5.5",
  google: "gemini-3.1-flash-lite",
  // ollama/custom: no safe guess about what's installed — keep the main model.
};

/** Aux-job model for a given main model config: same provider, auth, and
 *  endpoint; only the model id swaps to the provider's cheap tier. */
export function resolveSubagentModel(main: ModelConfig): ModelConfig {
  const cheap = main.provider ? CHEAP_MODEL_BY_PROVIDER[main.provider] : undefined;
  if (!cheap) return main;
  return { ...main, model: cheap };
}
