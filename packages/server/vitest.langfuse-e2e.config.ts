import { defineConfig } from "vitest/config";

// Opt-in live Langfuse visibility suite. This is isolated from the regular
// e2e config because it can perform network I/O when explicitly enabled.
export default defineConfig({
  test: {
    include: ["test/e2e/langfuse-visibility.e2e.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 90_000,
    pool: "forks",
  },
});
