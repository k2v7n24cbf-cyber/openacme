import type { Provider } from "@openacme/config";

// Re-export so existing callers (`@openacme/server/routes/setup.ts`,
// CLI setup wizard) keep working — the canonical home is `@openacme/config`
// now since the loader needs it to bootstrap config.yaml on first boot.
export { DEFAULT_MODEL_BY_PROVIDER } from "@openacme/config";

export interface ModelPreset {
  id: string;
  label: string;
  hint?: string;
}

/**
 * Curated model picks per provider. The setup wizard appends a "Custom…"
 * sentinel at the end so users can type any model ID. IDs were verified
 * against each provider's `/models` endpoint or canonical docs.
 */
export const MODEL_PRESETS: Record<Provider, ModelPreset[]> = {
  openai: [
    // ChatGPT subscription users: gpt-5.5 is the current supported Codex
    // backend default. Other OpenAI model IDs can be entered through Custom.
    { id: "gpt-5.5", label: "GPT-5.5", hint: "frontier (recommended)" },
  ],
  anthropic: [
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", hint: "most capable" },
    { id: "claude-fable-5", label: "Claude Fable 5", hint: "frontier" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "balanced (recommended)" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "fast & cheap" },
  ],
  google: [
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", hint: "deep reasoning" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", hint: "balanced (recommended)" },
    { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", hint: "cheapest" },
  ],
  openrouter: [
    { id: "anthropic/claude-opus-4.8", label: "Claude Opus 4.8", hint: "most capable" },
    { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", hint: "recommended" },
    { id: "openai/gpt-5.5", label: "GPT-5.5" },
    { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
    { id: "deepseek/deepseek-v4-pro", label: "DeepSeek v4 Pro", hint: "open-weight" },
    { id: "qwen/qwen3.7-max", label: "Qwen 3.7 Max" },
  ],
  ollama: [
    { id: "llama3.3", label: "Llama 3.3", hint: "general (recommended)" },
    { id: "qwen3", label: "Qwen 3", hint: "general" },
    { id: "qwen2.5-coder", label: "Qwen 2.5 Coder", hint: "coding" },
    { id: "deepseek-r1", label: "DeepSeek R1", hint: "reasoning" },
    { id: "gemma3", label: "Gemma 3", hint: "single GPU" },
    { id: "mistral", label: "Mistral 7B", hint: "small & fast" },
  ],
  custom: [],
};

/** Sentinel value used by the setup wizard to mean "open a free-text prompt". */
export const CUSTOM_MODEL_ID = "__custom__";
