import {
  createForensicRecorder,
  flushForensicRecorder,
  flushForensicWriters,
  getActiveTraceContext,
  redactHeaders,
  resolveForensicsConfig,
  sha256Hex,
  type ActiveTraceContext,
  type ForensicRecorder,
  type ForensicsConfig,
  type RawFileRecord,
} from "./forensics-recorder.js";
import {
  enterAIForensicContext,
  getAIForensicContext,
  setAIForensicContext,
  type AIForensicContext,
} from "./forensics-context.js";
import {
  buildForensicEventSelector,
  buildForensicEvidenceRef,
  buildForensicLocatorAttributes,
  buildForensicLocatorPayload,
  FORENSIC_LOOKUP_KEY,
  type ForensicEvidenceRefArgs,
  type ForensicLocatorArgs,
} from "./evidence-locator.js";

export type AiObservationContext = AIForensicContext;
export type EvidenceRecorder = ForensicRecorder;
export type EvidenceConfig = ForensicsConfig;
export type RawEvidenceFileRecord = RawFileRecord;
export type ObservationTraceContext = ActiveTraceContext;
export type EvidenceRefArgs = ForensicEvidenceRefArgs;
export type EvidenceLocatorArgs = ForensicLocatorArgs;

export const EVIDENCE_LOOKUP_KEY = FORENSIC_LOOKUP_KEY;

export function resolveEvidenceConfig(
  ...args: Parameters<typeof resolveForensicsConfig>
): EvidenceConfig {
  return resolveForensicsConfig(...args);
}

export function createEvidenceRecorder(
  opts: Parameters<typeof createForensicRecorder>[0] = {},
): EvidenceRecorder {
  return createForensicRecorder(opts);
}

export async function flushEvidenceRecorder(
  recorder: EvidenceRecorder | null | undefined,
): Promise<void> {
  await flushForensicRecorder(recorder);
}

export async function flushEvidenceWriters(): Promise<void> {
  await flushForensicWriters();
}

export function enterAiObservationContext<T>(
  observationContext: AiObservationContext,
  fn: () => T,
): T {
  return enterAIForensicContext(observationContext, fn);
}

export function setAiObservationContext(
  observationContext: AiObservationContext,
): void {
  setAIForensicContext(observationContext);
}

export function getAiObservationContext(): AiObservationContext | undefined {
  return getAIForensicContext();
}

export { getActiveTraceContext, redactHeaders, sha256Hex };

export function buildEvidenceEventSelector(
  ...args: Parameters<typeof buildForensicEventSelector>
): string {
  return buildForensicEventSelector(...args);
}

export function buildEvidenceRef(
  args: EvidenceRefArgs,
): ReturnType<typeof buildForensicEvidenceRef> {
  return buildForensicEvidenceRef(args);
}

export function buildEvidenceLocatorAttributes(
  args: EvidenceLocatorArgs,
): ReturnType<typeof buildForensicLocatorAttributes> {
  return buildForensicLocatorAttributes(args);
}

export function buildEvidenceLocatorPayload(
  args: EvidenceLocatorArgs,
): ReturnType<typeof buildForensicLocatorPayload> {
  return buildForensicLocatorPayload(args);
}
