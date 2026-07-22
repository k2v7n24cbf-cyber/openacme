import { describe, it, expect } from "vitest";
import type { ModelConfig } from "@openacme/config";
import { resolveSubagentModel } from "../src/subagent-model.js";

const base = (provider: ModelConfig["provider"], model: string): ModelConfig =>
  ({
    provider,
    model,
    auth: "oauth",
    apiKey: "k",
    baseUrl: "https://example.test/v1",
    headers: { "x-h": "1" },
    cacheTtl: "1h",
  }) as ModelConfig;

describe("resolveSubagentModel", () => {
  it("maps each provider to its cheap tier", () => {
    expect(resolveSubagentModel(base("anthropic", "claude-opus-4-7")).model).toBe(
      "claude-haiku-4-5"
    );
    expect(
      resolveSubagentModel(base("openrouter", "anthropic/claude-opus-4.7")).model
    ).toBe("anthropic/claude-haiku-4.5");
    expect(resolveSubagentModel(base("openai", "gpt-5.5")).model).toBe("gpt-5.5");
    expect(resolveSubagentModel(base("google", "gemini-3.1-pro-preview")).model).toBe(
      "gemini-3.1-flash-lite"
    );
  });

  it("keeps the main model for ollama and custom", () => {
    expect(resolveSubagentModel(base("ollama", "llama3.3")).model).toBe("llama3.3");
    expect(resolveSubagentModel(base("custom", "my-model")).model).toBe("my-model");
  });

  it("preserves auth, endpoint, headers, and cacheTtl", () => {
    const main = base("anthropic", "claude-opus-4-7");
    const out = resolveSubagentModel(main);
    expect(out.auth).toBe("oauth");
    expect(out.apiKey).toBe("k");
    expect(out.baseUrl).toBe("https://example.test/v1");
    expect(out.headers).toEqual({ "x-h": "1" });
    expect(out.cacheTtl).toBe("1h");
  });

  it("is idempotent when the main model is already the cheap tier", () => {
    const out = resolveSubagentModel(base("anthropic", "claude-haiku-4-5"));
    expect(out.model).toBe("claude-haiku-4-5");
    expect(resolveSubagentModel(out)).toEqual(out);
  });
});
