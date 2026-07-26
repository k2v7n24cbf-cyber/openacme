import type {
  ToolEntry,
  ToolOutcomeAttributeValue,
  ToolResultClassification,
  ToolResultClassifierContext,
} from "./types.js";

const MAX_FAILURE_MESSAGE_CHARS = 512;
const MAX_OUTCOME_ATTRIBUTES = 16;

type JsonObject = Record<string, unknown>;

export function classifyToolResult(
  entry: Pick<ToolEntry, "name" | "toolset" | "classifyResult">,
  args: Record<string, unknown>,
  output: string
): ToolResultClassification {
  const classifier = entry.classifyResult ?? classifyDefaultToolResult;
  try {
    return normalizeClassification(
      classifier({
        toolName: entry.name,
        toolset: entry.toolset,
        args,
        output,
      })
    );
  } catch (error) {
    return {
      resultStatus: "unknown",
      resultClassifier: "classifier_error",
      failureKind: "classifier_exception",
      failureMessage: truncateFailureMessage(errorMessage(error)),
      parsedJson: false,
    };
  }
}

export function classifyDefaultToolResult(
  context: ToolResultClassifierContext
): ToolResultClassification {
  const parsed = parseJsonObject(context.output);
  if (!parsed) {
    return {
      resultStatus: "success",
      resultClassifier: "default",
      parsedJson: false,
    };
  }

  const successFlag = booleanValue(parsed, "success");
  const okFlag = booleanValue(parsed, "ok");
  const failureMessage = resultFailureMessage(parsed);

  if (successFlag === false || okFlag === false || failureMessage) {
    return {
      resultStatus: "failure",
      resultClassifier: "default",
      failureKind: inferFailureKind(failureMessage, "explicit_error"),
      failureMessage,
      successFlag,
      okFlag,
      parsedJson: true,
    };
  }

  return {
    resultStatus: "success",
    resultClassifier: "default",
    successFlag,
    okFlag,
    parsedJson: true,
  };
}

export function classifyShellToolResult(
  context: ToolResultClassifierContext
): ToolResultClassification {
  const parsed = parseJsonObject(context.output);
  if (!parsed) return withClassifier(classifyDefaultToolResult(context), "shell");

  const base = classifyDefaultToolResult(context);
  const exitCode = numberValue(parsed, "exitCode");
  const failureMessage = resultFailureMessage(parsed);
  const outcomeAttributes = compactAttributes({
    command_family: "shell",
  });

  if (base.resultStatus === "failure") {
    return {
      ...base,
      resultClassifier: "shell",
      failureKind: inferCommandFailureKind(exitCode, failureMessage),
      failureMessage,
      exitCode,
      outcomeAttributes,
    };
  }

  return {
    ...base,
    resultClassifier: "shell",
    exitCode,
    outcomeAttributes,
  };
}

export function classifyProcessToolResult(
  context: ToolResultClassifierContext
): ToolResultClassification {
  const parsed = parseJsonObject(context.output);
  const action = stringValue(context.args, "action");
  if (!parsed) {
    return withClassifier(classifyDefaultToolResult(context), "process", {
      action,
    });
  }

  const base = classifyDefaultToolResult(context);
  const processStatus = stringValue(parsed, "status");
  const exitCode = numberValue(parsed, "exitCode");
  const failureMessage = resultFailureMessage(parsed);
  const outcomeAttributes = compactAttributes({
    action,
  });

  if (processStatus === "running") {
    return {
      resultStatus: "running",
      resultClassifier: "process",
      processStatus,
      exitCode,
      successFlag: booleanValue(parsed, "success"),
      parsedJson: true,
      outcomeAttributes,
    };
  }

  if (processStatus === "timed_out") {
    return {
      ...base,
      resultStatus: "failure",
      resultClassifier: "process",
      failureKind: "process_timeout",
      failureMessage: failureMessage ?? "Process timed out",
      exitCode,
      processStatus,
      outcomeAttributes,
    };
  }

  if (processStatus === "killed" && action !== "kill") {
    return {
      ...base,
      resultStatus: "failure",
      resultClassifier: "process",
      failureKind: "process_killed",
      failureMessage: failureMessage ?? "Process was killed",
      exitCode,
      processStatus,
      outcomeAttributes,
    };
  }

  if (processStatus === "exited" && exitCode !== undefined && exitCode !== 0) {
    return {
      ...base,
      resultStatus: "failure",
      resultClassifier: "process",
      failureKind: "process_exit_nonzero",
      failureMessage:
        failureMessage ?? `Process exited with code ${exitCode}`,
      exitCode,
      processStatus,
      outcomeAttributes,
    };
  }

  if (base.resultStatus === "failure") {
    return {
      ...base,
      resultClassifier: "process",
      failureKind: inferFailureKind(failureMessage, "process_error"),
      failureMessage,
      exitCode,
      processStatus,
      outcomeAttributes,
    };
  }

  return {
    ...base,
    resultClassifier: "process",
    exitCode,
    processStatus,
    outcomeAttributes,
  };
}

export function classifyFilesystemToolResult(
  context: ToolResultClassifierContext
): ToolResultClassification {
  const parsed = parseJsonObject(context.output);
  const base = withClassifier(
    classifyDefaultToolResult(context),
    "filesystem",
    filesystemAttributes(context.toolName, parsed)
  );

  if (!parsed) return base;

  if (context.toolName === "list_files" && hasPartialListError(parsed)) {
    return {
      ...base,
      resultStatus: "partial",
      failureKind: "partial_filesystem_error",
      failureMessage: "One or more directory entries could not be listed",
    };
  }

  if (base.resultStatus === "failure") {
    const failureMessage = base.failureMessage ?? resultFailureMessage(parsed);
    return {
      ...base,
      failureKind: inferFilesystemFailureKind(
        context.toolName,
        failureMessage
      ),
      failureMessage,
    };
  }

  return base;
}

function parseJsonObject(output: string): JsonObject | null {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as JsonObject;
  } catch {
    return null;
  }
}

function normalizeClassification(
  classification: ToolResultClassification
): ToolResultClassification {
  return {
    ...classification,
    failureMessage: classification.failureMessage
      ? truncateFailureMessage(classification.failureMessage)
      : undefined,
    outcomeAttributes: compactAttributes(classification.outcomeAttributes),
  };
}

function withClassifier(
  classification: ToolResultClassification,
  resultClassifier: string,
  outcomeAttributes?: Record<string, unknown>
): ToolResultClassification {
  return normalizeClassification({
    ...classification,
    resultClassifier,
    outcomeAttributes: compactAttributes({
      ...classification.outcomeAttributes,
      ...outcomeAttributes,
    }),
  });
}

function filesystemAttributes(
  toolName: string,
  parsed: JsonObject | null
): Record<string, ToolOutcomeAttributeValue> {
  const operation = filesystemOperation(toolName);
  const attrs: Record<string, unknown> = { operation };
  if (parsed) {
    const mediaKind = stringValue(parsed, "_media");
    if (mediaKind) attrs["media_kind"] = mediaKind;
    const mediaType = stringValue(parsed, "mediaType");
    if (mediaType) attrs["media_type"] = mediaType;
    const bytes = numberValue(parsed, "bytes");
    if (bytes !== undefined) attrs["bytes"] = bytes;
    const truncated = booleanValue(parsed, "truncated");
    if (truncated !== undefined) attrs["truncated"] = truncated;
    const count = numberValue(parsed, "count");
    if (count !== undefined) attrs["result_count"] = count;
  }
  return compactAttributes(attrs) ?? { operation };
}

function filesystemOperation(toolName: string): string {
  switch (toolName) {
    case "read_file":
      return "read";
    case "write_file":
      return "write";
    case "list_files":
      return "list";
    case "search_files":
      return "search";
    case "edit":
      return "edit";
    case "apply_patch":
      return "patch";
    default:
      return "filesystem";
  }
}

function hasPartialListError(parsed: JsonObject): boolean {
  const entries = parsed["entries"];
  return (
    Array.isArray(entries) &&
    entries.some(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "error"
    )
  );
}

function inferCommandFailureKind(
  exitCode: number | undefined,
  message: string | undefined
): string {
  const lower = (message ?? "").toLowerCase();
  if (lower.includes("timed out") || exitCode === -1) {
    return "command_timeout";
  }
  if (exitCode !== undefined && exitCode !== 0) {
    return "command_exit_nonzero";
  }
  return inferFailureKind(message, "command_error");
}

function inferFilesystemFailureKind(
  toolName: string,
  message: string | undefined
): string {
  const lower = (message ?? "").toLowerCase();
  if (
    lower.includes("enoent") ||
    lower.includes("not found") ||
    lower.includes("no such file")
  ) {
    return "file_not_found";
  }
  if (lower.includes("not a regular file")) return "file_not_regular";
  if (lower.includes("too large")) return "file_too_large";
  if (lower.includes("binary file")) return "file_unsupported_binary";
  if (
    lower.includes("permission") ||
    lower.includes("eacces") ||
    lower.includes("denied")
  ) {
    return "file_permission_denied";
  }
  if (lower.includes("patch parse error")) return "patch_parse_error";
  if (lower.includes("oldstring and newstring are identical")) {
    return "no_change";
  }
  if (lower.includes("could not find oldstring")) return "edit_no_match";
  if (lower.includes("found multiple matches")) return "edit_ambiguous_match";
  if (lower.includes("invalid fileglob")) return "validation_error";
  if (toolName === "write_file") return "file_write_error";
  if (toolName === "read_file") return "file_read_error";
  if (toolName === "edit") return "edit_apply_error";
  if (toolName === "apply_patch") return "patch_apply_error";
  return "filesystem_error";
}

function inferFailureKind(
  message: string | undefined,
  fallback: string
): string {
  const lower = (message ?? "").toLowerCase();
  if (!lower) return fallback;
  if (lower.includes("rate-limit") || lower.includes("rate limited") || lower.includes("429")) {
    return "rate_limited";
  }
  if (
    lower.includes("not found") ||
    lower.includes("unknown") ||
    lower.includes("no such")
  ) {
    return "not_found";
  }
  if (
    lower.includes("invalid") ||
    lower.includes("required") ||
    lower.includes("parse error") ||
    lower.includes("empty")
  ) {
    return "validation_error";
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "timeout";
  }
  return fallback;
}

function resultFailureMessage(parsed: JsonObject): string | undefined {
  return firstString(parsed, ["error", "message", "reason"]);
}

function firstString(
  object: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = stringValue(object, key);
    if (value) return truncateFailureMessage(value);
  }
  return undefined;
}

function stringValue(
  object: Record<string, unknown>,
  key: string
): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(
  object: Record<string, unknown>,
  key: string
): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanValue(
  object: Record<string, unknown>,
  key: string
): boolean | undefined {
  const value = object[key];
  return typeof value === "boolean" ? value : undefined;
}

function compactAttributes(
  attributes: Record<string, unknown> | undefined
): Record<string, ToolOutcomeAttributeValue> | undefined {
  if (!attributes) return undefined;
  const out: Record<string, ToolOutcomeAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (Object.keys(out).length >= MAX_OUTCOME_ATTRIBUTES) break;
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] =
        typeof value === "string" ? truncateFailureMessage(value) : value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function truncateFailureMessage(message: string): string {
  return message.length > MAX_FAILURE_MESSAGE_CHARS
    ? `${message.slice(0, MAX_FAILURE_MESSAGE_CHARS)}...`
    : message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
