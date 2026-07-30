import { spawn } from "node:child_process";
import type { Config } from "@openacme/config";
import type {
  JsonValue,
  PythonExecutionPort,
  PythonExecutionRequest,
  PythonExecutionResult,
} from "@openacme/workflows";

const PYTHON_BIN =
  process.env["OPENACME_PYTHON"] ?? process.env["PYTHON"] ?? "python3";
const DEFAULT_TIMEOUT_MS = 30_000;

const PYTHON_BOOTSTRAP = String.raw`
import ast
import io
import json
import sys
import traceback
from contextlib import redirect_stdout, redirect_stderr

def to_jsonable(value):
    try:
        json.dumps(value)
        return value
    except TypeError:
        return repr(value)

def run(req):
    code = str(req.get("code", ""))
    ns = {"__name__": "__workflow__", "input": req.get("input"), "output": None}
    out_buf = io.StringIO()
    err_buf = io.StringIO()
    try:
        tree = ast.parse(code, mode="exec")
        last_expr = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last_expr = tree.body.pop()
        with redirect_stdout(out_buf), redirect_stderr(err_buf):
            if tree.body:
                exec(compile(tree, "<openacme-workflow>", "exec"), ns)
            if last_expr is not None:
                value = eval(
                    compile(ast.Expression(last_expr.value), "<openacme-workflow>", "eval"),
                    ns,
                )
            else:
                value = ns.get("output")
        return {
            "ok": True,
            "stdout": out_buf.getvalue(),
            "stderr": err_buf.getvalue(),
            "value": to_jsonable(value),
        }
    except SystemExit:
        return {
            "ok": False,
            "stdout": out_buf.getvalue(),
            "stderr": err_buf.getvalue() + "SystemExit suppressed in workflow Python\n",
            "value": None,
        }
    except BaseException:
        return {
            "ok": False,
            "stdout": out_buf.getvalue(),
            "stderr": err_buf.getvalue() + traceback.format_exc(),
            "value": None,
        }

try:
    req = json.load(sys.stdin)
    result = run(req)
except BaseException:
    result = {
        "ok": False,
        "stdout": "",
        "stderr": traceback.format_exc(),
        "value": None,
    }

sys.stdout.write(json.dumps(result) + "\n")
sys.stdout.flush()
`;

interface PythonProcessResponse {
  ok: boolean;
  stdout: string;
  stderr: string;
  value: JsonValue;
}

class WorkflowPythonRuntimeError extends Error {
  readonly details: JsonValue;

  constructor(message: string, details: JsonValue) {
    super(message);
    this.name = "WorkflowPythonRuntimeError";
    this.details = details;
  }
}

/**
 * Workflow-local Python execution adapter. It intentionally uses a fresh
 * subprocess per step so workflow Python state is per-step isolated and cannot
 * leak across workflow runs, foreach items, or later steps.
 */
export class WorkflowPythonRuntime implements PythonExecutionPort {
  constructor(private readonly config: Config) {}

  async execute(req: PythonExecutionRequest): Promise<PythonExecutionResult> {
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const response = await runPythonSubprocess({
      code: req.code,
      input: req.input,
      timeoutMs,
      cwd: this.config.dataDir,
      signal: req.signal,
    });
    if (!response.ok) {
      throw new WorkflowPythonRuntimeError("Workflow Python execution failed", {
        stdout: response.stdout,
        stderr: response.stderr,
      });
    }
    return {
      output: response.value,
      stdout: response.stdout,
      stderr: response.stderr,
    };
  }
}

function runPythonSubprocess(args: {
  code: string;
  input: JsonValue;
  timeoutMs: number;
  cwd: string;
  signal?: AbortSignal;
}): Promise<PythonProcessResponse> {
  return new Promise((resolve, reject) => {
    if (args.signal?.aborted) {
      reject(
        new WorkflowPythonRuntimeError("Workflow Python canceled", {
          stdout: "",
          stderr: "",
        }),
      );
      return;
    }
    const child = spawn(PYTHON_BIN, ["-u", "-c", PYTHON_BOOTSTRAP], {
      cwd: args.cwd,
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
    }, args.timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      canceled = true;
      child.kill("SIGKILL");
    };
    args.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (canceled) {
        reject(
          new WorkflowPythonRuntimeError("Workflow Python canceled", {
            stdout,
            stderr,
          }),
        );
        return;
      }
      if (timedOut) {
        reject(
          new WorkflowPythonRuntimeError(
            `Workflow Python timed out after ${args.timeoutMs}ms`,
            { stdout: "", stderr },
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new WorkflowPythonRuntimeError(
            `Workflow Python process exited with code ${code ?? "unknown"}`,
            { stdout, stderr },
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as PythonProcessResponse);
      } catch (err) {
        reject(
          new WorkflowPythonRuntimeError(
            `Workflow Python returned invalid JSON: ${
              err instanceof Error ? err.message : String(err)
            }`,
            { stdout, stderr },
          ),
        );
      }
    });

    child.stdin.end(
      JSON.stringify({
        code: args.code,
        input: args.input,
      }),
    );
  });
}
