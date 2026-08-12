import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileHostedIntegrationArtifactStore } from "../src/index.js";

let dataDir: string;
let runCounter = 0;
let nowMs = Date.parse("2026-08-12T10:00:00.000Z");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-artifacts-"));
  runCounter = 0;
  nowMs = Date.parse("2026-08-12T10:00:00.000Z");
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function store() {
  return createFileHostedIntegrationArtifactStore({
    dataDir,
    now: () => new Date(nowMs),
    createRunId: () => `call_${++runCounter}`,
    inlineResultTokenLimit: 8,
  });
}

describe("hosted integration run directories and response artifacts", () => {
  it("creates a unique run directory under the family workspace for every invocation", async () => {
    const artifacts = store();

    const first = await artifacts.createRun({
      familyId: "qualys",
      toolName: "qualys_count_assets",
      generationId: "gen_1",
      actorId: "agent:analyst",
      input: { query: "status:active" },
    });
    const second = await artifacts.createRun({
      familyId: "qualys",
      toolName: "qualys_count_assets",
      generationId: "gen_1",
      actorId: "agent:analyst",
      input: { query: "status:inactive" },
    });

    expect(first).toMatchObject({
      run: {
        id: "call_1",
        familyId: "qualys",
        toolName: "qualys_count_assets",
        generationId: "gen_1",
        status: "running",
      },
      familyHome: path.join(
        dataDir,
        "hosted-integrations",
        "workspaces",
        "qualys",
        "home",
      ),
      runDir: path.join(
        dataDir,
        "hosted-integrations",
        "workspaces",
        "qualys",
        "runs",
        "call_1",
      ),
    });
    expect(second.run.id).toBe("call_2");
    await expect(
      readFile(path.join(first.runDir, "input.sanitized.json"), "utf-8"),
    ).resolves.toContain("status:active");
  });

  it("returns small responses inline and writes sanitized output", async () => {
    const artifacts = store();
    const { run } = await artifacts.createRun({
      familyId: "qualys",
      toolName: "qualys_count_assets",
      generationId: "gen_1",
      actorId: "agent:analyst",
      input: {},
    });

    await expect(
      artifacts.completeRunSuccess({
        runId: run.id,
        familyId: run.familyId,
        result: { count: 2 },
      }),
    ).resolves.toEqual({ ok: true, result: { count: 2 } });
    await expect(
      readFile(
        path.join(
          dataDir,
          "hosted-integrations",
          "workspaces",
          "qualys",
          "runs",
          "call_1",
          "output.json",
        ),
        "utf-8",
      ),
    ).resolves.toContain('"count": 2');
  });

  it("spills large responses to result_ref instead of returning them inline", async () => {
    const artifacts = store();
    const { run } = await artifacts.createRun({
      familyId: "qualys",
      toolName: "qualys_count_assets",
      generationId: "gen_1",
      actorId: "agent:analyst",
      input: {},
    });

    const envelope = await artifacts.completeRunSuccess({
      runId: run.id,
      familyId: run.familyId,
      result: { rows: Array.from({ length: 20 }, (_, index) => ({ index })) },
    });

    expect(envelope).toMatchObject({
      ok: true,
      result_ref: {
        type: "artifact",
        run_id: "call_1",
        name: "output.json",
        size_bytes: expect.any(Number),
        estimated_tokens: expect.any(Number),
      },
    });
    expect(JSON.stringify(envelope)).not.toContain(dataDir);
    expect("result" in envelope).toBe(false);
  });

  it("sanitizes caller-visible input, output, error, and diagnostics artifacts before write", async () => {
    const artifacts = store();
    const { run, runDir } = await artifacts.createRun({
      familyId: "qualys",
      toolName: "qualys_login",
      generationId: "gen_1",
      actorId: "agent:analyst",
      input: {
        username: "api-user",
        password: "super-secret-password",
      },
    });

    await artifacts.writeDiagnostics({
      runId: run.id,
      familyId: run.familyId,
      diagnostics: { token: "raw-token", safe: "visible" },
    });
    await artifacts.completeRunError({
      runId: run.id,
      familyId: run.familyId,
      error: {
        code: "upstream_failed",
        message: "token raw-token failed",
        apiToken: "raw-token",
      },
    });
    await artifacts.completeRunSuccess({
      runId: run.id,
      familyId: run.familyId,
      result: {
        ok: true,
        access_token: "raw-token",
        nested: { secret: "nested-secret" },
      },
    });

    const combined = [
      await readFile(path.join(runDir, "input.sanitized.json"), "utf-8"),
      await readFile(path.join(runDir, "diagnostics.json"), "utf-8"),
      await readFile(path.join(runDir, "error.json"), "utf-8"),
      await readFile(path.join(runDir, "output.json"), "utf-8"),
    ].join("\n");
    expect(combined).not.toContain("super-secret-password");
    expect(combined).not.toContain("raw-token");
    expect(combined).not.toContain("nested-secret");
    expect(combined).toContain("[REDACTED]");
  });
});
