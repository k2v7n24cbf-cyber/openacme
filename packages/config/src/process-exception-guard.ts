import { createLogger, type AppLogger } from "./logger.js";
import { shutdownOpenAcmeTelemetry } from "./telemetry-bootstrap.js";

export interface ProcessExceptionGuardHandlers {
  unhandledRejection(reason: unknown, promise: Promise<unknown>): Promise<void>;
  uncaughtException(
    error: Error,
    origin: NodeJS.UncaughtExceptionOrigin,
  ): Promise<void>;
}

export interface ProcessExceptionGuardOptions {
  scope?: string;
  logger?: Pick<AppLogger, "error" | "warn">;
  shutdownTelemetry?: () => Promise<void>;
  setExitCode?: (code: number) => void;
  exit?: (code: number) => void;
}

let registered = false;

export function registerOpenAcmeProcessExceptionGuard(
  opts: ProcessExceptionGuardOptions = {},
): boolean {
  if (registered) return false;
  registered = true;
  const handlers = createOpenAcmeProcessExceptionHandlers(opts);
  process.on("unhandledRejection", (reason, promise) => {
    void handlers.unhandledRejection(reason, promise);
  });
  process.on("uncaughtException", (error, origin) => {
    void handlers.uncaughtException(error, origin);
  });
  return true;
}

export function createOpenAcmeProcessExceptionHandlers(
  opts: ProcessExceptionGuardOptions = {},
): ProcessExceptionGuardHandlers {
  const logger = opts.logger ?? createLogger(opts.scope ?? "process.guard");
  const shutdownTelemetry = opts.shutdownTelemetry ?? shutdownOpenAcmeTelemetry;
  const setExitCode =
    opts.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let handlingFatal = false;

  const handleFatal = async (
    kind: "unhandledRejection" | "uncaughtException",
    err: unknown,
    extra: Record<string, unknown>,
  ) => {
    if (handlingFatal) {
      setExitCode(1);
      return;
    }
    handlingFatal = true;
    logger.error(
      { err: errorFromUnknown(err), fatal: true, kind, ...extra },
      `process-level ${kind}`,
    );
    try {
      await shutdownTelemetry();
    } catch (shutdownErr) {
      logger.warn(
        { err: errorFromUnknown(shutdownErr), kind },
        "process-level telemetry shutdown failed",
      );
    } finally {
      setExitCode(1);
      exit(1);
    }
  };

  return {
    unhandledRejection(reason, promise) {
      return handleFatal("unhandledRejection", reason, {
        promise: promise?.constructor?.name,
      });
    },
    uncaughtException(error, origin) {
      return handleFatal("uncaughtException", error, { origin });
    },
  };
}

function errorFromUnknown(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}
