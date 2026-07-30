import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ConfigSchema } from "@openacme/config";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowPythonRuntime } from "../src/workflow-python-runtime.js";

let dataDir: string | null = null;

afterEach(() => {
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  }
});

function runtime() {
  dataDir = mkdtempSync(path.join(tmpdir(), "openacme-workflow-python-"));
  return new WorkflowPythonRuntime(
    ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    }),
  );
}

describe("WorkflowPythonRuntime", () => {
  it("kills the subprocess when the workflow signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const execution = runtime().execute({
      code: [
        "import time",
        "print('before cancel', flush=True)",
        "time.sleep(1)",
        "output = 'late'",
      ].join("\n"),
      input: {},
      timeoutMs: 5_000,
      signal: controller.signal,
    } as Parameters<WorkflowPythonRuntime["execute"]>[0] & {
      signal: AbortSignal;
    });

    setTimeout(() => controller.abort(), 250);

    await expect(execution).rejects.toMatchObject({
      message: "Workflow Python canceled",
      details: expect.objectContaining({
        stdout: expect.any(String),
        stderr: expect.any(String),
      }),
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
