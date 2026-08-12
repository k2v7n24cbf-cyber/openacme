import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostedIntegrationPythonRuntime } from "../src/index.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-python-"));
});

afterEach(async () => {
  delete process.env["OPENACME_HOSTED_RUNTIME_PARENT_SECRET"];
  await rm(dataDir, { recursive: true, force: true });
});

describe("HostedIntegrationPythonRuntime", () => {
  it("lists tools from a fixture Python family", async () => {
    const fixture = await createPythonFixture(`
def list_tools():
    return [{
        "name": "qualys_count_assets",
        "title": "Count assets",
        "description": "Count assets matching a safe query.",
        "inputSchema": {"type": "object", "properties": {}},
        "classification": {
            "operation": "read",
            "freshness": "live",
            "idempotency": "idempotent",
            "execution": "sync",
            "approval": "none",
        },
    }]
`);

    await expect(runtime().listTools(fixture.request)).resolves.toMatchObject({
      ok: true,
      tools: [{ name: "qualys_count_assets" }],
    });
  });

  it("passes config and secrets through ToolContext", async () => {
    const fixture = await createPythonFixture(`
def call_tool(name, args, ctx):
    return {
        "endpoint": ctx["config"]["endpoint"],
        "secret": ctx["secrets"]["apiToken"],
    }
`);

    await expect(
      runtime().callTool({
        ...fixture.request,
        toolName: "qualys_count_assets",
        args: {},
        context: {
          ...fixture.context,
          config: { endpoint: "https://qualys.example.test" },
          secrets: { apiToken: "token_123" },
        },
      }),
    ).resolves.toEqual({
      ok: true,
      result: {
        endpoint: "https://qualys.example.test",
        secret: "token_123",
      },
    });
  });

  it("allows writes only inside run dir and family home", async () => {
    const outsidePath = path.join(dataDir, "outside.txt");
    const fixture = await createPythonFixture(`
from pathlib import Path

def call_tool(name, args, ctx):
    Path(ctx["run_dir"], "run.txt").write_text("run")
    Path(ctx["family_home"], "home.txt").write_text("home")
    blocked = False
    try:
        Path(args["outside"]).write_text("outside")
    except PermissionError:
        blocked = True
    return {"blocked": blocked}
`);

    await expect(
      runtime().callTool({
        ...fixture.request,
        toolName: "qualys_write_files",
        args: { outside: outsidePath },
        context: fixture.context,
      }),
    ).resolves.toEqual({ ok: true, result: { blocked: true } });
    await expect(readFile(path.join(fixture.runDir, "run.txt"), "utf-8"))
      .resolves.toBe("run");
    await expect(readFile(path.join(fixture.familyHome, "home.txt"), "utf-8"))
      .resolves.toBe("home");
    await expect(access(outsidePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not pass undeclared parent process environment", async () => {
    process.env["OPENACME_HOSTED_RUNTIME_PARENT_SECRET"] = "leak";
    const fixture = await createPythonFixture(`
import os

def call_tool(name, args, ctx):
    return {"leaked": os.environ.get("OPENACME_HOSTED_RUNTIME_PARENT_SECRET")}
`);

    await expect(
      runtime().callTool({
        ...fixture.request,
        toolName: "qualys_env",
        args: {},
        context: fixture.context,
      }),
    ).resolves.toEqual({ ok: true, result: { leaked: null } });
  });

  it("returns a structured timeout error", async () => {
    const fixture = await createPythonFixture(`
import time

def call_tool(name, args, ctx):
    time.sleep(1)
    return {"late": True}
`);

    await expect(
      runtime().callTool({
        ...fixture.request,
        timeoutMs: 100,
        toolName: "qualys_slow",
        args: {},
        context: fixture.context,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "timeout",
        message: expect.stringContaining("100ms"),
      },
    });
  });

  it("normalizes raised Python exceptions as tool_bug", async () => {
    const fixture = await createPythonFixture(`
def call_tool(name, args, ctx):
    raise ValueError("bad fixture")
`);

    await expect(
      runtime().callTool({
        ...fixture.request,
        toolName: "qualys_broken",
        args: {},
        context: fixture.context,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "tool_bug",
        message: expect.stringContaining("ValueError"),
      },
    });
  });
});

function runtime() {
  return new HostedIntegrationPythonRuntime();
}

async function createPythonFixture(source: string) {
  const filesRoot = path.join(dataDir, "files");
  const familyHome = path.join(dataDir, "home");
  const runDir = path.join(dataDir, "runs", randomUUID());
  await mkdir(filesRoot, { recursive: true });
  await mkdir(familyHome, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(filesRoot, "qualys.py"), source, "utf-8");
  return {
    filesRoot,
    familyHome,
    runDir,
    request: {
      familyId: "qualys",
      generationId: "gen_1",
      filesRoot,
      runtime: {
        language: "python" as const,
        entrypoint: "qualys.py",
        defaultTimeoutMs: 5_000,
        inlineResultTokenLimit: 8_000,
        maxConcurrency: 1,
        runtimePolicy: {
          filesystem: "run_dir_and_family_home" as const,
          processEnv: "tool_context_only" as const,
          subprocess: "denied" as const,
          network: "denied" as const,
          declaredEgress: [],
        },
        dependencyPolicy: {
          installDuringInvocation: false as const,
          allowedPackages: [],
          deniedPackages: [],
        },
      },
    },
    context: {
      familyId: "qualys",
      generationId: "gen_1",
      runId: "call_1",
      familyHome,
      runDir,
      config: {},
      secrets: {},
    },
  };
}
