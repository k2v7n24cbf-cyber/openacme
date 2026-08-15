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
  it("dispatches to the derived tool handler by default", async () => {
    const fixture = await createPythonFixture(
      `
def tool_qualys_count_assets(args, context):
    return {"dispatch": "derived", "value": args["value"]}

def call_tool(name, args, ctx):
    return {"dispatch": "legacy"}
`,
    );

    await expect(
      runtime().callTool({
        ...fixture.request,
        toolName: "qualys_count_assets",
        args: { value: "ok" },
        context: fixture.context,
      }),
    ).resolves.toEqual({
      ok: true,
      result: { dispatch: "derived", value: "ok" },
    });
  });

  it("executes standard hooks around derived handlers in order", async () => {
    const fixture = await createPythonFixture(
      `
def authenticate(ctx):
    ctx["events"] = ["authenticate"]
    return {"token": "auth-token"}

def before_tool_call(tool_name, args, ctx, auth):
    ctx["events"].append("before_tool_call")
    next_args = dict(args)
    next_args["normalized"] = auth["token"]
    return next_args

def tool_qualys_count_assets(args, context):
    context["events"].append("handler")
    return {
        "normalized": args["normalized"],
        "auth": context["auth"]["token"],
        "events": list(context["events"]),
    }

def after_tool_call(tool_name, args, ctx, result, auth):
    ctx["events"].append("after_tool_call")
    next_result = dict(result)
    next_result["after_arg"] = args["normalized"]
    next_result["events"] = list(ctx["events"])
    return next_result
`,
    );

    await expect(
      runtime().callTool({
        ...fixture.request,
        toolName: "qualys_count_assets",
        args: {},
        context: fixture.context,
      }),
    ).resolves.toEqual({
      ok: true,
      result: {
        normalized: "auth-token",
        auth: "auth-token",
        after_arg: "auth-token",
        events: [
          "authenticate",
          "before_tool_call",
          "handler",
          "after_tool_call",
        ],
      },
    });
  });

  it("normalizes authenticate errors before the derived handler runs", async () => {
    const fixture = await createPythonFixture(
      `
class ToolError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)

def authenticate(ctx):
    raise ToolError("missing_config", "missing token")

def tool_qualys_count_assets(args, context):
    return {"handler": "should-not-run"}
`,
    );

    await expect(
      runtime().callTool({
        ...fixture.request,
        toolName: "qualys_count_assets",
        args: {},
        context: fixture.context,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "missing_config",
        message: "missing token",
      },
    });
  });

  it("ignores legacy call_tool routers and requires a derived handler", async () => {
    const fixture = await createPythonFixture(`
def call_tool(name, args, ctx):
    return {"dispatch": "legacy", "tool": name}
`);

    await expect(
      runtime().callTool({
        ...fixture.request,
        toolName: "qualys_count_assets",
        args: {},
        context: fixture.context,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "tool_bug",
        message: expect.stringContaining("tool_qualys_count_assets"),
      },
    });
  });

  it("returns tool_bug when derived dispatch has no matching handler", async () => {
    const fixture = await createPythonFixture(
      `
def call_tool(name, args, ctx):
    return {"dispatch": "legacy"}
`,
    );

    await expect(
      runtime().callTool({
        ...fixture.request,
        toolName: "qualys_count_assets",
        args: {},
        context: fixture.context,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "tool_bug",
        message: expect.stringContaining("tool_qualys_count_assets"),
      },
    });
  });

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
def tool_qualys_count_assets(args, ctx):
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

def tool_qualys_write_files(args, ctx):
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

def tool_qualys_env(args, ctx):
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

def tool_qualys_slow(args, ctx):
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
def tool_qualys_broken(args, ctx):
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
        message: "bad fixture",
        details: {
          exception_type: "ValueError",
          traceback: expect.stringContaining("ValueError"),
        },
      },
    });
  });

  it("preserves custom Python tool error codes", async () => {
    const fixture = await createPythonFixture(`
class ToolError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)

def tool_qualys_filtered(args, ctx):
    raise ToolError("bad_arguments", "invalid filter field")
`);

    await expect(
      runtime().callTool({
        ...fixture.request,
        toolName: "qualys_filtered",
        args: {},
        context: fixture.context,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "bad_arguments",
        message: "invalid filter field",
        details: {
          exception_type: "ToolError",
          traceback: expect.stringContaining("ToolError"),
        },
      },
    });
  });
});

function runtime() {
  return new HostedIntegrationPythonRuntime();
}

async function createPythonFixture(
  source: string,
) {
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
