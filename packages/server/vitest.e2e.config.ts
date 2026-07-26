import { defineConfig } from "vitest/config";

// e2e suite — boots a real listening daemon per file against the fake LLM.
// Kept out of the default `*.test.ts` unit run (which the `test` script and
// `pnpm test` use) because these are slower and depend on built workspace deps.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    exclude: ["test/e2e/langfuse-visibility.e2e.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
  },
});
