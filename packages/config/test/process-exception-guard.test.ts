import { describe, expect, it, vi } from "vitest";
import { createOpenAcmeProcessExceptionHandlers } from "../src/process-exception-guard.js";

function fakeLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  };
}

describe("process exception guard", () => {
  it("logs, flushes telemetry, and exits on unhandled rejection", async () => {
    const logger = fakeLogger();
    const shutdownTelemetry = vi.fn(async () => {});
    const setExitCode = vi.fn();
    const exit = vi.fn();
    const handlers = createOpenAcmeProcessExceptionHandlers({
      logger,
      shutdownTelemetry,
      setExitCode,
      exit,
    });

    await handlers.unhandledRejection(
      new Error("provider stream escaped"),
      Promise.resolve(),
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        fatal: true,
        kind: "unhandledRejection",
        err: expect.objectContaining({ message: "provider stream escaped" }),
      }),
      "process-level unhandledRejection",
    );
    expect(shutdownTelemetry).toHaveBeenCalledOnce();
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("swallows telemetry shutdown failures and still exits", async () => {
    const logger = fakeLogger();
    const shutdownTelemetry = vi.fn(async () => {
      throw new Error("collector down");
    });
    const exit = vi.fn();
    const handlers = createOpenAcmeProcessExceptionHandlers({
      logger,
      shutdownTelemetry,
      setExitCode: vi.fn(),
      exit,
    });

    await handlers.uncaughtException(
      new Error("unexpected fatal"),
      "uncaughtException",
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "uncaughtException",
        err: expect.objectContaining({ message: "collector down" }),
      }),
      "process-level telemetry shutdown failed",
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not run telemetry shutdown twice for repeated fatal events", async () => {
    const shutdownTelemetry = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const setExitCode = vi.fn();
    const handlers = createOpenAcmeProcessExceptionHandlers({
      logger: fakeLogger(),
      shutdownTelemetry,
      setExitCode,
      exit: vi.fn(),
    });

    const first = handlers.unhandledRejection("first", Promise.resolve());
    await handlers.uncaughtException(new Error("second"), "uncaughtException");
    await first;

    expect(shutdownTelemetry).toHaveBeenCalledOnce();
    expect(setExitCode).toHaveBeenCalledWith(1);
  });
});
