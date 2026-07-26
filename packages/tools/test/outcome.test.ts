import { describe, expect, it } from "vitest";
import {
  classifyDefaultToolResult,
  classifyFilesystemToolResult,
  classifyProcessToolResult,
  classifyShellToolResult,
  classifyToolResult,
} from "../src/outcome.js";
import type { ToolEntry } from "../src/types.js";

const BASE_CONTEXT = {
  toolName: "example",
  toolset: "test",
  args: {},
};

function classifyDefault(output: string) {
  return classifyDefaultToolResult({ ...BASE_CONTEXT, output });
}

describe("tool outcome classifiers", () => {
  it("classifies common JSON failure contracts without tool-specific logic", () => {
    expect(classifyDefault(JSON.stringify({ error: "bad input" }))).toMatchObject({
      resultStatus: "failure",
      resultClassifier: "default",
      failureKind: "explicit_error",
      failureMessage: "bad input",
    });

    expect(
      classifyDefault(JSON.stringify({ success: false, error: "not found" }))
    ).toMatchObject({
      resultStatus: "failure",
      failureKind: "not_found",
      successFlag: false,
    });

    expect(classifyDefault(JSON.stringify({ ok: false, error: "invalid" }))).toMatchObject({
      resultStatus: "failure",
      failureKind: "validation_error",
      okFlag: false,
    });
  });

  it("keeps plain text and successful JSON as successful tool results", () => {
    expect(classifyDefault("plain output")).toMatchObject({
      resultStatus: "success",
      resultClassifier: "default",
      parsedJson: false,
    });

    expect(classifyDefault(JSON.stringify({ success: true, count: 0 }))).toMatchObject({
      resultStatus: "success",
      successFlag: true,
    });
  });

  it("lets shell classify command-level failures by exit code and timeout", () => {
    expect(
      classifyShellToolResult({
        toolName: "shell",
        toolset: "terminal",
        args: { command: "false" },
        output: JSON.stringify({
          success: false,
          error: "Command exited with code 7",
          exitCode: 7,
        }),
      })
    ).toMatchObject({
      resultStatus: "failure",
      resultClassifier: "shell",
      failureKind: "command_exit_nonzero",
      exitCode: 7,
    });

    expect(
      classifyShellToolResult({
        toolName: "shell",
        toolset: "terminal",
        args: { command: "sleep 10" },
        output: JSON.stringify({
          success: false,
          error: "Command timed out - shell session was reset",
          exitCode: -1,
        }),
      })
    ).toMatchObject({
      resultStatus: "failure",
      failureKind: "command_timeout",
      exitCode: -1,
    });
  });

  it("lets process distinguish running, failed completion, and requested kill", () => {
    expect(
      classifyProcessToolResult({
        toolName: "process",
        toolset: "terminal",
        args: { action: "start" },
        output: JSON.stringify({ success: true, status: "running", exitCode: null }),
      })
    ).toMatchObject({
      resultStatus: "running",
      resultClassifier: "process",
      processStatus: "running",
    });

    expect(
      classifyProcessToolResult({
        toolName: "process",
        toolset: "terminal",
        args: { action: "run" },
        output: JSON.stringify({
          success: false,
          status: "exited",
          exitCode: 9,
          error: "Process exited with code 9",
        }),
      })
    ).toMatchObject({
      resultStatus: "failure",
      failureKind: "process_exit_nonzero",
      exitCode: 9,
      processStatus: "exited",
    });

    expect(
      classifyProcessToolResult({
        toolName: "process",
        toolset: "terminal",
        args: { action: "kill" },
        output: JSON.stringify({
          success: true,
          status: "killed",
          exitCode: null,
        }),
      })
    ).toMatchObject({
      resultStatus: "success",
      processStatus: "killed",
    });
  });

  it("lets filesystem classify file read failures, media reads, partial lists, and no-match search", () => {
    expect(
      classifyFilesystemToolResult({
        toolName: "read_file",
        toolset: "filesystem",
        args: { path: "missing.txt" },
        output: JSON.stringify({ error: "ENOENT: no such file or directory" }),
      })
    ).toMatchObject({
      resultStatus: "failure",
      resultClassifier: "filesystem",
      failureKind: "file_not_found",
    });

    expect(
      classifyFilesystemToolResult({
        toolName: "read_file",
        toolset: "filesystem",
        args: { path: "image.png" },
        output: JSON.stringify({
          success: true,
          _media: "image",
          mediaType: "image/png",
          bytes: 123,
        }),
      })
    ).toMatchObject({
      resultStatus: "success",
      outcomeAttributes: {
        operation: "read",
        media_kind: "image",
      },
    });

    expect(
      classifyFilesystemToolResult({
        toolName: "list_files",
        toolset: "filesystem",
        args: { path: "." },
        output: JSON.stringify({
          success: true,
          entries: [{ name: "[error: denied]", type: "error" }],
        }),
      })
    ).toMatchObject({
      resultStatus: "partial",
      failureKind: "partial_filesystem_error",
    });

    expect(
      classifyFilesystemToolResult({
        toolName: "search_files",
        toolset: "filesystem",
        args: { pattern: "nope" },
        output: JSON.stringify({
          success: true,
          matches: [],
          count: 0,
          note: "No matches found",
        }),
      })
    ).toMatchObject({
      resultStatus: "success",
      outcomeAttributes: {
        operation: "search",
        result_count: 0,
      },
    });
  });

  it("contains classifier exceptions and preserves tool execution", () => {
    const entry = {
      name: "custom",
      toolset: "test",
      classifyResult: () => {
        throw new Error("classifier failed");
      },
    } as Pick<ToolEntry, "name" | "toolset" | "classifyResult">;

    expect(
      classifyToolResult(entry, {}, JSON.stringify({ success: true }))
    ).toMatchObject({
      resultStatus: "unknown",
      resultClassifier: "classifier_error",
      failureKind: "classifier_exception",
      failureMessage: "classifier failed",
    });
  });
});
