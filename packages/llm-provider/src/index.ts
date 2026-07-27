export {
  getModel,
  listProviders,
  getEffectiveContextWindow,
  isAnthropicLongContextDisabled,
  supportsToolResultMedia,
  resolveAuthMode,
  type ProviderInfo,
} from "./registry.js";
export {
  MODEL_PRESETS,
  DEFAULT_MODEL_BY_PROVIDER,
  CUSTOM_MODEL_ID,
  type ModelPreset,
} from "./models.js";
export {
  detectProviderCredentials,
  type ProviderCredentials,
  type CredentialSource,
} from "./credentials.js";
export { resolveSubagentModel } from "./subagent-model.js";
export {
  EVIDENCE_LOOKUP_KEY,
  buildEvidenceEventSelector,
  buildEvidenceLocatorAttributes,
  buildEvidenceLocatorPayload,
  buildEvidenceRef,
  createEvidenceRecorder,
  enterAiObservationContext,
  flushEvidenceRecorder,
  flushEvidenceWriters,
  getActiveTraceContext,
  getAiObservationContext,
  redactHeaders,
  resolveEvidenceConfig,
  setAiObservationContext,
  sha256Hex,
  type AiObservationContext,
  type EvidenceConfig,
  type EvidenceLocatorArgs,
  type EvidenceRecorder,
  type EvidenceRefArgs,
  type ObservationTraceContext,
  type RawEvidenceFileRecord,
} from "./ai-observation.js";
export {
  sanitizeSpanAttributes,
  startOpenAcmeSpan,
  withOpenAcmeSpan,
  type OpenAcmeSpanAttributes,
  type OpenAcmeSpanHandle,
  type OpenAcmeSpanKind,
  type StartOpenAcmeSpanOptions,
} from "./observability.js";
export {
  getProviderRequestCountForRun,
  observeProviderRequest,
  type ProviderRequestObservationOptions,
} from "./provider-observation.js";
