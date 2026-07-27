import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { writeAtomic0600 } from "@openacme/config";

export { writeAtomic0600 };

export const PID_FILENAME = "openacme.pid";
export const LOG_FILENAME = "openacme.log";

export function pidPath(dataDir: string): string {
  return path.join(dataDir, PID_FILENAME);
}

export function logPath(dataDir: string): string {
  return path.join(dataDir, LOG_FILENAME);
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function readPid(dataDir: string): number | null {
  try {
    const raw = fs.readFileSync(pidPath(dataDir), "utf-8").trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function clearPid(dataDir: string): void {
  try { fs.unlinkSync(pidPath(dataDir)); } catch { /* ignore */ }
}

/** Check whether a PID is alive without sending a real signal. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Fast TCP probe — does not handshake, just confirms a listener exists. */
export function probePort(host: string, port: number, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const settle = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
    // localhost / 0.0.0.0 — connect to 127.0.0.1 to be safe
    const target = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    socket.connect(port, target);
  });
}

/** Poll a URL until it returns 2xx or timeout. */
export async function pollHealth(url: string, timeoutMs = 5000, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(intervalMs * 4) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** Read the last `n` lines of a file (best-effort, returns "" on missing). */
export function tailFile(filePath: string, lines: number): string {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const all = content.split(/\r?\n/);
    // strip a trailing empty line from the final newline
    if (all.length > 0 && all[all.length - 1] === "") all.pop();
    return all.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const SERVICE_ENV_PASSTHROUGH_KEYS = [
  "OPENACME_TELEMETRY",
  "OPENACME_DEBUG",
  "OPENACME_LOG_FILE",
  "OPENACME_OBSERVABILITY",
  "OPENACME_TELEMETRY_SERVICE_NAME",
  "OPENACME_AI_FORENSICS",
  "OPENACME_AI_FORENSICS_CAPTURE_RAW",
  "OPENACME_AI_FORENSICS_DIR",
  "OPENACME_AI_FORENSICS_RETENTION_DAYS",
  "OPENACME_AI_FORENSICS_MAX_RUN_BYTES",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_PUBLIC_KEY",
  "OPENACME_OTLP_TRACES_ENDPOINT",
  "OPENACME_OTLP_LOGS_ENDPOINT",
] as const;

/**
 * Environment persisted into service managers. Keep this list to non-secret
 * toggles and endpoints; credentials belong in the process environment or
 * data-dir .env, not world-readable launchd/systemd unit files.
 */
export function serviceEnvironmentPassthrough(
  env: Record<string, string | undefined> = process.env
): Array<[string, string]> {
  return SERVICE_ENV_PASSTHROUGH_KEYS.flatMap((key) => {
    const value = env[key];
    return typeof value === "string" && value.length > 0
      ? [[key, value] as [string, string]]
      : [];
  });
}

/**
 * Spawn a command and capture stdout/stderr. Resolves with the result —
 * caller decides whether non-zero is an error. We resolve (instead of reject)
 * because launchctl/systemctl exit codes carry meaning beyond pass/fail
 * (e.g. status queries return non-zero when the unit isn't loaded).
 */
export function runCmd(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Resolve the absolute path to the openacme CLI entry script. In dev
 * (linked workspace) `process.argv[1]` already points at the dist file.
 * Test override: OPENACME_BIN_OVERRIDE.
 */
export function resolveBinaryPath(): string {
  const override = process.env["OPENACME_BIN_OVERRIDE"];
  if (override) return path.resolve(override);
  const argvBin = process.argv[1];
  if (argvBin) {
    const real = fs.realpathSync(argvBin);
    return real;
  }
  throw new Error("Cannot resolve openacme binary path (process.argv[1] missing)");
}

/** Absolute path to the node binary that ran us. */
export function resolveNodePath(): string {
  return process.execPath;
}
