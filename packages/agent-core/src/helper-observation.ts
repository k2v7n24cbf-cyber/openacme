import {
  buildEvidenceEventSelector,
  buildEvidenceLocatorAttributes,
  buildEvidenceLocatorPayload,
  createEvidenceRecorder,
  enterAiObservationContext,
  getAiObservationContext,
  getProviderRequestCountForRun,
  withOpenAcmeSpan,
  type OpenAcmeSpanHandle,
} from "@openacme/llm-provider";
import type { ModelConfig } from "@openacme/config";
import type { UsageKind } from "@openacme/db";
import {
  buildAiObservationContext,
  buildAiTelemetrySettings,
  type BuiltAiTelemetrySettings,
} from "./telemetry.js";

type MetadataValue = string | number | boolean;

export type AiHelperEvidenceFile =
  | "compression.summarizer.prompt"
  | "compression.summarizer.input"
  | "compression.summarizer.output"
  | "compression.memory_flush.system"
  | "compression.memory_flush.messages"
  | "compression.memory_flush.output";

const AI_HELPER_EVIDENCE_PATHS: Record<AiHelperEvidenceFile, string> = {
  "compression.summarizer.prompt": "compression/summarizer/prompt.txt",
  "compression.summarizer.input": "compression/summarizer/input.json",
  "compression.summarizer.output": "compression/summarizer/output.txt",
  "compression.memory_flush.system":
    "compression/memory-flush/model-input.system.txt",
  "compression.memory_flush.messages":
    "compression/memory-flush/model-input.messages.json",
  "compression.memory_flush.output": "compression/memory-flush/output.txt",
};

export type AiHelperObservationProfile =
  | "compression.summarizer"
  | "compression.memory_flush"
  | "subagent.structured";

const AI_HELPER_OBSERVATION_PROFILES: Record<
  AiHelperObservationProfile,
  {
    eventType: string;
    eventSelectorType: string;
    relativeEvidenceDir: string;
  }
> = {
  "compression.summarizer": {
    eventType: "compression.summarizer",
    eventSelectorType: "compression.summarizer.start",
    relativeEvidenceDir: "compression/summarizer",
  },
  "compression.memory_flush": {
    eventType: "compression.memory_flush",
    eventSelectorType: "compression.memory_flush.start",
    relativeEvidenceDir: "compression/memory-flush",
  },
  "subagent.structured": {
    eventType: "subagent.structured",
    eventSelectorType: "subagent.structured.start",
    relativeEvidenceDir: "subagent/structured",
  },
};

export interface AiHelperObservationArgs {
  functionId: string;
  agentId?: string;
  sessionId?: string;
  taskId?: string;
  messageId?: string;
  kind?: UsageKind;
  model: ModelConfig;
  profile?: AiHelperObservationProfile;
  eventType?: string;
  eventSelectorType?: string;
  selector?: string | number;
  eventSelector?: string;
  relativeEvidenceDir?: string;
  metadata?: Record<string, MetadataValue | undefined>;
}

export interface AiHelperObservation {
  readonly telemetry: BuiltAiTelemetrySettings;
  readonly forensicRunId: string;
  readonly parentForensicRunId: string | undefined;
  readonly captureRaw: boolean;
  readonly maxRawFileBytes: number;
  readonly locatorPayload: Record<string, unknown>;
  readonly locatorAttributes: Record<string, unknown>;
  readonly evidenceRunDir: string | undefined;
  providerRequestCount(): number | undefined;
  recordEvent(type: string, data?: Record<string, unknown>): void;
  writeEvidenceFile(file: AiHelperEvidenceFile, data: string | Buffer): void;
  writeRawFile(relativePath: string, data: string | Buffer): void;
  run<T>(fn: (span: OpenAcmeSpanHandle) => Promise<T> | T): Promise<T>;
}

export function createAiHelperObservation(
  args: AiHelperObservationArgs,
): AiHelperObservation {
  const parentForensicRunId = getAiObservationContext()?.forensicRunId;
  const telemetry = buildAiTelemetrySettings({
    functionId: args.functionId,
    agentId: args.agentId,
    sessionId: args.sessionId,
    taskId: args.taskId,
    messageId: args.messageId,
    kind: args.kind,
    model: args.model,
    metadata: args.metadata,
  });
  const observationContext = buildAiObservationContext({
    forensicRunId: telemetry.forensicRunId,
    parentForensicRunId,
    agentId: args.agentId,
    sessionId: args.sessionId,
    taskId: args.taskId,
    messageId: args.messageId,
    kind: args.kind,
    model: args.model,
  });
  const profile = args.profile
    ? AI_HELPER_OBSERVATION_PROFILES[args.profile]
    : undefined;
  const eventType = args.eventType ?? profile?.eventType;
  const eventSelectorType =
    args.eventSelectorType ?? profile?.eventSelectorType;
  const relativeEvidenceDir =
    args.relativeEvidenceDir ?? profile?.relativeEvidenceDir;
  const eventSelector =
    args.eventSelector ??
    (eventType
      ? buildEvidenceEventSelector(eventSelectorType ?? eventType)
      : undefined);
  const locatorArgs = eventType
    ? {
        forensicRunId: telemetry.forensicRunId,
        sessionId: args.sessionId,
        eventType,
        selector: args.selector,
        eventSelector,
        relativeEvidenceDir,
      }
    : undefined;
  const locatorAttributes = locatorArgs
    ? buildEvidenceLocatorAttributes(locatorArgs)
    : {};
  const locatorPayload = locatorArgs
    ? buildEvidenceLocatorPayload(locatorArgs)
    : {};
  let evidenceRecorder: ReturnType<typeof createEvidenceRecorder> | null = null;
  let evidenceRecorderFailed = false;

  const recorder = () => {
    if (evidenceRecorderFailed) return null;
    if (evidenceRecorder) return evidenceRecorder;
    try {
      evidenceRecorder = createEvidenceRecorder({
        context: observationContext,
      });
      return evidenceRecorder;
    } catch {
      evidenceRecorderFailed = true;
      return null;
    }
  };

  return {
    telemetry,
    forensicRunId: telemetry.forensicRunId,
    parentForensicRunId,
    get captureRaw() {
      return recorder()?.captureRaw === true;
    },
    get maxRawFileBytes() {
      return recorder()?.maxRawFileBytes ?? 0;
    },
    locatorPayload,
    locatorAttributes,
    get evidenceRunDir() {
      return recorder()?.runDir;
    },
    providerRequestCount() {
      return getProviderRequestCountForRun(telemetry.forensicRunId);
    },
    recordEvent(type, data) {
      safeObservationWrite(() => recorder()?.recordEvent(type, data));
    },
    writeEvidenceFile(file, data) {
      safeObservationWrite(() =>
        recorder()?.writeRawFile(AI_HELPER_EVIDENCE_PATHS[file], data),
      );
    },
    writeRawFile(relativePath, data) {
      safeObservationWrite(() => recorder()?.writeRawFile(relativePath, data));
    },
    run(fn) {
      return enterAiObservationContext(observationContext, () =>
        withOpenAcmeSpan(
          "openacme.ai.helper",
          {
            "openacme.span.type": "ai_helper",
            "openacme.ai.function_id": telemetry.settings.functionId,
            "openacme.forensic.run_id": telemetry.forensicRunId,
            "openacme.forensic.parent_run_id": parentForensicRunId,
            "openacme.agent.id": args.agentId,
            "openacme.session.id": args.sessionId,
            "openacme.task.id": args.taskId,
            "openacme.message.id": args.messageId,
            "openacme.usage.kind": args.kind,
            "openacme.provider": args.model.provider,
            "openacme.model": args.model.model,
            "openacme.auth_mode": observationContext.authMode,
            ...locatorAttributes,
          },
          fn,
        ),
      );
    },
  };
}

function safeObservationWrite(fn: () => void): void {
  try {
    fn();
  } catch {
    // Evidence collection is best-effort and must never alter helper calls.
  }
}
