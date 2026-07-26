import { randomUUID } from "node:crypto";
import type { TelemetrySettings } from "ai";
import type { ModelConfig } from "@openacme/config";
import type { UsageKind } from "@openacme/db";
import type { AIForensicContext } from "@openacme/llm-provider";

type Env = Record<string, string | undefined>;
type MetadataValue = string | number | boolean;

export interface AiTelemetryCapture {
  recordInputs: boolean;
  recordOutputs: boolean;
}

export interface AiTelemetryArgs {
  functionId: string;
  forensicRunId?: string;
  agentId?: string;
  sessionId?: string;
  taskId?: string;
  messageId?: string;
  kind?: UsageKind;
  model?: ModelConfig;
  metadata?: Record<string, MetadataValue | undefined>;
}

export interface AiForensicContextArgs {
  forensicRunId: string;
  parentForensicRunId?: string;
  agentId?: string;
  sessionId?: string;
  taskId?: string;
  messageId?: string;
  kind?: UsageKind;
  model?: ModelConfig;
}

export interface BuiltAiTelemetrySettings {
  forensicRunId: string;
  settings: TelemetrySettings;
}

const TRUE_VALUES = new Set(["1", "true", "yes"]);

export function resolveAiTelemetryCapture(
  env: Env = process.env
): AiTelemetryCapture {
  return {
    recordInputs: truthy(env["OPENACME_AI_TELEMETRY_RECORD_INPUTS"]),
    recordOutputs: truthy(env["OPENACME_AI_TELEMETRY_RECORD_OUTPUTS"]),
  };
}

export function buildAiTelemetrySettings(
  args: AiTelemetryArgs,
  env: Env = process.env
): BuiltAiTelemetrySettings {
  const forensicRunId = args.forensicRunId ?? randomUUID();
  const capture = resolveAiTelemetryCapture(env);
  const metadata: Record<string, MetadataValue> = {};
  add(metadata, "forensicRunId", forensicRunId);
  add(metadata, "agentId", args.agentId);
  add(metadata, "sessionId", args.sessionId);
  add(metadata, "taskId", args.taskId);
  add(metadata, "messageId", args.messageId);
  add(metadata, "kind", args.kind);
  if (args.model) {
    add(metadata, "provider", args.model.provider);
    add(metadata, "model", args.model.model);
    add(metadata, "authMode", authModeLabel(args.model));
  }
  if (args.metadata) {
    for (const [key, value] of Object.entries(args.metadata)) {
      add(metadata, key, value);
    }
  }

  return {
    forensicRunId,
    settings: {
      isEnabled: true,
      recordInputs: capture.recordInputs,
      recordOutputs: capture.recordOutputs,
      functionId: args.functionId,
      metadata,
    },
  };
}

export function buildAiForensicContext(
  args: AiForensicContextArgs
): AIForensicContext {
  return {
    forensicRunId: args.forensicRunId,
    parentForensicRunId: args.parentForensicRunId,
    agentId: args.agentId,
    sessionId: args.sessionId,
    taskId: args.taskId,
    messageId: args.messageId,
    kind: args.kind,
    provider: args.model?.provider,
    model: args.model?.model,
    authMode: args.model ? authModeLabel(args.model) : undefined,
  };
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && TRUE_VALUES.has(value.trim().toLowerCase());
}

function add(
  target: Record<string, MetadataValue>,
  key: string,
  value: MetadataValue | undefined
): void {
  if (value === undefined) return;
  target[key] = value;
}

function authModeLabel(model: ModelConfig): string | undefined {
  if (model.provider === "ollama") return "local";
  return model.auth ?? "api_key";
}
