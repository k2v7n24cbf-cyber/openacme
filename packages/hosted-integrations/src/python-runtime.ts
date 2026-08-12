import { spawn } from "node:child_process";
import {
  HostedIntegrationRuntimeSettingsSchema,
  HostedIntegrationToolSpecSchema,
  JsonObjectSchema,
  JsonValueSchema,
  type HostedIntegrationFamilyId,
  type HostedIntegrationRuntimeSettings,
  type HostedIntegrationToolName,
  type HostedIntegrationToolSpec,
  type JsonObject,
  type JsonValue,
} from "./schemas.js";
import { resolveInsideRoot } from "./file-access.js";

const PYTHON_BIN =
  process.env["OPENACME_PYTHON"] ?? process.env["PYTHON"] ?? "python3";

const PYTHON_BOOTSTRAP = String.raw`
import builtins
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import traceback

ORIGINAL_OPEN = builtins.open
ORIGINAL_IO_OPEN = io.open
ORIGINAL_MKDIR = os.mkdir
ORIGINAL_MAKEDIRS = os.makedirs

def to_jsonable(value):
    try:
        json.dumps(value)
        return value
    except TypeError:
        return repr(value)

def real_path(value):
    return os.path.realpath(os.path.abspath(os.fspath(value)))

def is_under(path, root):
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False

def write_requested(mode):
    return any(flag in mode for flag in ("w", "a", "x", "+"))

def install_policy(req):
    policy = req["runtime"]["runtimePolicy"]
    ctx = req.get("context") or {}
    allowed_roots = []
    if "run_dir" in ctx:
        allowed_roots.append(real_path(ctx["run_dir"]))
    if "family_home" in ctx and policy["filesystem"] == "run_dir_and_family_home":
        allowed_roots.append(real_path(ctx["family_home"]))

    def assert_allowed_write(path):
        target = real_path(path)
        if not any(is_under(target, root) for root in allowed_roots):
            raise PermissionError(
                "hosted integration write denied outside run_dir/family_home"
            )

    def guarded_open(file, mode="r", *args, **kwargs):
        if not isinstance(file, int) and write_requested(str(mode)):
            assert_allowed_write(file)
        return ORIGINAL_OPEN(file, mode, *args, **kwargs)

    def guarded_io_open(file, mode="r", *args, **kwargs):
        if not isinstance(file, int) and write_requested(str(mode)):
            assert_allowed_write(file)
        return ORIGINAL_IO_OPEN(file, mode, *args, **kwargs)

    def guarded_mkdir(path, *args, **kwargs):
        assert_allowed_write(path)
        return ORIGINAL_MKDIR(path, *args, **kwargs)

    def guarded_makedirs(name, *args, **kwargs):
        assert_allowed_write(name)
        return ORIGINAL_MAKEDIRS(name, *args, **kwargs)

    builtins.open = guarded_open
    io.open = guarded_io_open
    os.mkdir = guarded_mkdir
    os.makedirs = guarded_makedirs

    if policy["subprocess"] == "denied":
        def denied_subprocess(*args, **kwargs):
            raise PermissionError("hosted integration subprocess denied")
        subprocess.Popen = denied_subprocess
        subprocess.run = denied_subprocess
        subprocess.call = denied_subprocess
        subprocess.check_call = denied_subprocess
        subprocess.check_output = denied_subprocess

def load_module(entrypoint):
    entrypoint = real_path(entrypoint)
    spec = importlib.util.spec_from_file_location("openacme_hosted_family", entrypoint)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load hosted integration entrypoint")
    module = importlib.util.module_from_spec(spec)
    sys.modules["openacme_hosted_family"] = module
    spec.loader.exec_module(module)
    return module

def run(req):
    out_buf = io.StringIO()
    err_buf = io.StringIO()
    try:
        sys.path.insert(0, req["filesRoot"])
        install_policy(req)
        with contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(err_buf):
            module = load_module(req["entrypointPath"])
            operation = req["operation"]
            if operation == "list_tools":
                tools = module.list_tools()
                return {
                    "ok": True,
                    "tools": to_jsonable(tools),
                    "stdout": out_buf.getvalue(),
                    "stderr": err_buf.getvalue(),
                }
            if operation == "call_tool":
                result = module.call_tool(req["toolName"], req.get("args") or {}, req["context"])
                return {
                    "ok": True,
                    "result": to_jsonable(result),
                    "stdout": out_buf.getvalue(),
                    "stderr": err_buf.getvalue(),
                }
            raise RuntimeError("unknown hosted integration operation")
    except BaseException as exc:
        return {
            "ok": False,
            "error": {
                "code": "tool_bug",
                "message": traceback.format_exc(),
                "details": {
                    "exception_type": type(exc).__name__,
                    "stdout": out_buf.getvalue(),
                    "stderr": err_buf.getvalue(),
                },
            },
        }

try:
    request = json.load(sys.stdin)
    response = run(request)
except BaseException:
    response = {
        "ok": False,
        "error": {
            "code": "runtime_error",
            "message": traceback.format_exc(),
            "details": {},
        },
    }

sys.stdout.write(json.dumps(response) + "\n")
sys.stdout.flush()
`;

export interface HostedIntegrationPythonRuntimeOptions {
  pythonBin?: string;
}

export interface HostedIntegrationPythonRuntimeRequestBase {
  familyId: HostedIntegrationFamilyId | string;
  generationId: string;
  filesRoot: string;
  runtime: HostedIntegrationRuntimeSettings;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HostedIntegrationToolContext {
  familyId: HostedIntegrationFamilyId | string;
  generationId: string;
  runId: string;
  familyHome: string;
  runDir: string;
  config: JsonObject;
  secrets: JsonObject;
}

export interface HostedIntegrationPythonCallToolRequest
  extends HostedIntegrationPythonRuntimeRequestBase {
  toolName: HostedIntegrationToolName | string;
  args: JsonObject;
  context: HostedIntegrationToolContext;
}

export type HostedIntegrationPythonRuntimeErrorCode =
  | "runtime_error"
  | "timeout"
  | "tool_bug";

export interface HostedIntegrationPythonRuntimeError {
  code: HostedIntegrationPythonRuntimeErrorCode;
  message: string;
  details?: JsonValue;
}

export type HostedIntegrationPythonListToolsResult =
  | { ok: true; tools: HostedIntegrationToolSpec[] }
  | { ok: false; error: HostedIntegrationPythonRuntimeError };

export type HostedIntegrationPythonCallToolResult =
  | { ok: true; result: JsonValue }
  | { ok: false; error: HostedIntegrationPythonRuntimeError };

interface PythonProcessResponse {
  ok: boolean;
  tools?: unknown;
  result?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
}

export class HostedIntegrationPythonRuntime {
  private readonly pythonBin: string;
  private readonly activeByFamily = new Map<string, number>();
  private readonly waitersByFamily = new Map<string, Array<() => void>>();

  constructor(options: HostedIntegrationPythonRuntimeOptions = {}) {
    this.pythonBin = options.pythonBin ?? PYTHON_BIN;
  }

  async listTools(
    request: HostedIntegrationPythonRuntimeRequestBase,
  ): Promise<HostedIntegrationPythonListToolsResult> {
    const response = await this.runPython({
      ...this.prepareRequest(request),
      operation: "list_tools",
    });
    if (!response.ok) return { ok: false, error: parseRuntimeError(response) };
    return {
      ok: true,
      tools: HostedIntegrationToolSpecSchema.array().parse(response.tools),
    };
  }

  async callTool(
    request: HostedIntegrationPythonCallToolRequest,
  ): Promise<HostedIntegrationPythonCallToolResult> {
    const args = JsonObjectSchema.parse(request.args);
    const context = parseToolContext(request.context);
    const prepared = this.prepareRequest(request);
    const response = await this.withFamilyConcurrency(
      String(request.familyId),
      prepared.runtime.maxConcurrency,
      () =>
        this.runPython({
          ...prepared,
          operation: "call_tool",
          toolName: request.toolName,
          args,
          context,
        }),
    );
    if (!response.ok) return { ok: false, error: parseRuntimeError(response) };
    return { ok: true, result: JsonValueSchema.parse(response.result) };
  }

  private prepareRequest(request: HostedIntegrationPythonRuntimeRequestBase) {
    const runtime = HostedIntegrationRuntimeSettingsSchema.parse(
      request.runtime,
    );
    const entrypointPath = resolveInsideRoot(
      request.filesRoot,
      runtime.entrypoint,
      "generation files root",
    );
    return {
      familyId: request.familyId,
      generationId: request.generationId,
      filesRoot: request.filesRoot,
      entrypointPath,
      runtime,
      timeoutMs: request.timeoutMs ?? runtime.defaultTimeoutMs,
      signal: request.signal,
    };
  }

  private runPython(
    request: Record<string, unknown> & {
      timeoutMs: number;
      signal?: AbortSignal;
    },
  ): Promise<PythonProcessResponse> {
    return new Promise((resolve) => {
      if (request.signal?.aborted) {
        resolve(timeoutError(request.timeoutMs));
        return;
      }

      const child = spawn(this.pythonBin, ["-u", "-c", PYTHON_BOOTSTRAP], {
        cwd: String(request.filesRoot),
        env: runtimeEnv(String(request.filesRoot)),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let canceled = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, request.timeoutMs);
      const onAbort = () => {
        canceled = true;
        child.kill("SIGKILL");
      };
      const cleanup = () => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(runtimeError(error.message, { stderr }));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (timedOut || canceled) {
          resolve(timeoutError(request.timeoutMs));
          return;
        }
        if (code !== 0) {
          resolve(
            runtimeError(`Python process exited with code ${code ?? "unknown"}`, {
              stderr,
              stdout,
            }),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) as PythonProcessResponse);
        } catch (error) {
          resolve(
            runtimeError(
              `Python process returned invalid JSON: ${
                error instanceof Error ? error.message : String(error)
              }`,
              { stderr, stdout },
            ),
          );
        }
      });

      const { timeoutMs: _timeoutMs, signal: _signal, ...payload } = request;
      child.stdin.end(JSON.stringify(payload));
    });
  }

  private async withFamilyConcurrency<T>(
    familyId: string,
    maxConcurrency: number,
    run: () => Promise<T>,
  ): Promise<T> {
    await this.acquireFamilySlot(familyId, maxConcurrency);
    try {
      return await run();
    } finally {
      this.releaseFamilySlot(familyId);
    }
  }

  private acquireFamilySlot(
    familyId: string,
    maxConcurrency: number,
  ): Promise<void> {
    const active = this.activeByFamily.get(familyId) ?? 0;
    if (active < maxConcurrency) {
      this.activeByFamily.set(familyId, active + 1);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const waiters = this.waitersByFamily.get(familyId) ?? [];
      waiters.push(resolve);
      this.waitersByFamily.set(familyId, waiters);
    }).then(() => {
      this.activeByFamily.set(
        familyId,
        (this.activeByFamily.get(familyId) ?? 0) + 1,
      );
    });
  }

  private releaseFamilySlot(familyId: string): void {
    const nextActive = Math.max(0, (this.activeByFamily.get(familyId) ?? 1) - 1);
    if (nextActive === 0) {
      this.activeByFamily.delete(familyId);
    } else {
      this.activeByFamily.set(familyId, nextActive);
    }
    const waiters = this.waitersByFamily.get(familyId);
    const next = waiters?.shift();
    if (!waiters || waiters.length === 0) {
      this.waitersByFamily.delete(familyId);
    }
    next?.();
  }
}

function parseToolContext(
  context: HostedIntegrationToolContext,
): Record<string, JsonValue> {
  return {
    family_id: String(context.familyId),
    generation_id: context.generationId,
    run_id: context.runId,
    family_home: context.familyHome,
    run_dir: context.runDir,
    config: JsonObjectSchema.parse(context.config),
    secrets: JsonObjectSchema.parse(context.secrets),
  };
}

function runtimeEnv(filesRoot: string): NodeJS.ProcessEnv {
  return {
    OPENACME_HOSTED_INTEGRATION: "1",
    PATH: process.env["PATH"] ?? "",
    PYTHONNOUSERSITE: "1",
    PYTHONPATH: filesRoot,
  };
}

function parseRuntimeError(
  response: PythonProcessResponse,
): HostedIntegrationPythonRuntimeError {
  if (response.error) {
    return {
      code: parseRuntimeErrorCode(response.error.code),
      message:
        typeof response.error.message === "string"
          ? response.error.message
          : "Hosted integration Python runtime failed",
      details: JsonValueSchema.optional().parse(response.error.details),
    };
  }
  return {
    code: "runtime_error",
    message: "Hosted integration Python runtime failed",
  };
}

function parseRuntimeErrorCode(
  value: unknown,
): HostedIntegrationPythonRuntimeErrorCode {
  if (value === "tool_bug" || value === "timeout" || value === "runtime_error") {
    return value;
  }
  return "runtime_error";
}

function runtimeError(
  message: string,
  details: JsonValue,
): PythonProcessResponse {
  return {
    ok: false,
    error: {
      code: "runtime_error",
      message,
      details,
    },
  };
}

function timeoutError(timeoutMs: number): PythonProcessResponse {
  return {
    ok: false,
    error: {
      code: "timeout",
      message: `Hosted integration Python timed out after ${timeoutMs}ms`,
      details: {},
    },
  };
}
