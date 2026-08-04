import { existsSync } from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startE2EServer, type E2EServer } from "./support/harness.js";
import { makeClient, assistantText, waitUntil } from "./support/client.js";

const MEMORY_RECALL_TIMEOUT_MS = 45_000;

/**
 * Memory recall (the read side): after an agent saves a fact, a later turn
 * surfaces it. The selector runs through the model's structured-output path —
 * the stub returns every memory the manifest names, so recall is deterministic.
 * The recalled bytes are injected as a leading text part the model reads, so
 * the stub's echo reflects them back — proving recall reached the model input.
 */
describe("memory recall (e2e)", () => {
  let srv: E2EServer;
  let c: ReturnType<typeof makeClient>;

  beforeAll(async () => {
    srv = await startE2EServer();
    c = makeClient(srv.baseUrl);
    await c.createAgent("helper");
  });
  afterAll(async () => {
    await srv.close();
  });

  it("surfaces a saved memory on a later turn", async () => {
    // Turn 1 — write the fact.
    const write = JSON.stringify({
      command: "create",
      path: "project-x.md",
      file_text: "Project X ships on Friday.",
    });
    await c.chat("helper", `note this [[mock:tool:memory:${write}]]`);
    const memPath = path.join(srv.dataDir, "agents", "helper", "memory", "project-x.md");
    await waitUntil(async () => existsSync(memPath), {
      timeoutMs: MEMORY_RECALL_TIMEOUT_MS,
    });

    // Turn 2 — a fresh session. Recall is per-agent (not per-session), so the
    // fact is in scope; the selector picks it and it lands in the model input,
    // which the stub echoes back.
    const { sessionId } = await c.chat("helper", "what's coming up?");
    await waitUntil(
      async () => {
        const a = (await c.messages(sessionId)).find((m) => m.role === "assistant");
        return !!a && assistantText(a.parts).includes("Project X ships on Friday");
      },
      { timeoutMs: MEMORY_RECALL_TIMEOUT_MS }
    );

    const a = (await c.messages(sessionId)).find((m) => m.role === "assistant")!;
    expect(assistantText(a.parts), "recall should reach the model input").toContain(
      "Project X ships on Friday"
    );
  }, MEMORY_RECALL_TIMEOUT_MS + 15_000);
});
