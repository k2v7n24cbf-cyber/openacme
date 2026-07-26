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
  createForensicRecorder,
  getActiveTraceContext,
  redactHeaders,
  resolveForensicsConfig,
  sha256Hex,
  type ActiveTraceContext,
  type ForensicRecorder,
  type ForensicsConfig,
  type RawFileRecord,
} from "./forensics-recorder.js";
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
  enterAIForensicContext,
  getAIForensicContext,
  setAIForensicContext,
  type AIForensicContext,
} from "./forensics-context.js";
export {
  forensicFetch,
  getAIForensicProviderRequestCount,
  type ForensicFetchOptions,
} from "./forensics-fetch.js";
export {
  FORENSIC_LOOKUP_KEY,
  buildForensicEventSelector,
  buildForensicEvidenceRef,
  buildForensicLocatorAttributes,
  buildForensicLocatorPayload,
  buildSessionTimelineLocator,
  type ForensicEvidenceRefArgs,
  type ForensicLocatorArgs,
  type SessionTimelineLocatorArgs,
} from "./evidence-locator.js";
