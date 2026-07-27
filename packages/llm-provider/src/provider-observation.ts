import {
  createForensicRecorder,
  redactHeaders,
  type ForensicRecorder,
} from "./forensics-recorder.js";
import { getAIForensicContext } from "./forensics-context.js";
import { withOpenAcmeSpan } from "./observability.js";
import {
  buildForensicEventSelector,
  buildForensicLocatorAttributes,
  buildForensicLocatorPayload,
} from "./evidence-locator.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

export interface ProviderRequestObservationOptions {
  provider: string;
  model: string;
  authMode?: string;
  preTransformBody?: unknown;
  recorder?: ForensicRecorder;
}

const providerRequestOrdinals = new Map<string, number>();

export function getProviderRequestCountForRun(
  forensicRunId: string | undefined,
): number | undefined {
  if (!forensicRunId) return undefined;
  return providerRequestOrdinals.get(forensicRunId);
}

export async function observeProviderRequest(
  input: FetchInput,
  init: FetchInit,
  opts: ProviderRequestObservationOptions,
  execute: () => Promise<Response>,
): Promise<Response> {
  const recorder = opts.recorder ?? createForensicRecorder();
  const forensicContext = getAIForensicContext();
  const forensicRunId =
    recorder.forensicRunId ?? forensicContext?.forensicRunId;
  const ordinal = nextOrdinal(forensicRunId ?? "global");
  const requestDir = providerRequestDir(ordinal, opts.provider, opts.model);
  const requestEventSelector = buildForensicEventSelector("provider.request", {
    ordinal,
  });
  const locator = {
    forensicRunId,
    sessionId: forensicContext?.sessionId,
    eventType: "provider.request",
    selector: ordinal,
    eventSelector: requestEventSelector,
    relativeEvidenceDir: requestDir,
  };
  const responseLocator = {
    forensicRunId,
    sessionId: forensicContext?.sessionId,
    eventType: "provider.response",
    selector: ordinal,
    eventSelector: buildForensicEventSelector("provider.response", {
      ordinal,
    }),
    relativeEvidenceDir: requestDir,
  };
  const method = init?.method ?? "GET";
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const requestBody = bodyPresence(init?.body);
  const preTransformBody = bodyPresence(opts.preTransformBody);

  return withOpenAcmeSpan(
    "openacme.provider.request",
    {
      "openacme.span.type": "provider_request",
      "openacme.forensic.run_id": forensicRunId,
      "openacme.provider": opts.provider,
      "openacme.model": opts.model,
      "openacme.auth_mode": opts.authMode,
      "openacme.provider.request_ordinal": ordinal,
      "http.request.method": method,
      "url.full": url,
      ...buildForensicLocatorAttributes(locator),
      "openacme.provider.request_body_present": requestBody.present,
      "openacme.provider.pre_transform_body_present": preTransformBody.present,
    },
    async (span) => {
      safeRecordEvent(recorder, "provider.request", {
        provider: opts.provider,
        model: opts.model,
        authMode: opts.authMode,
        ordinal,
        method,
        url,
        headers: redactHeaders(headersFromInit(init?.headers)),
        traceId: span.traceId,
        spanId: span.spanId,
        ...buildForensicLocatorPayload(locator),
        requestBodyPresent: requestBody.present,
        requestBodyKind: requestBody.kind,
        preTransformBodyPresent: preTransformBody.present,
        preTransformBodyKind: preTransformBody.kind,
      });

      let res: Response;
      try {
        res = await execute();
      } catch (err) {
        safeRecordEvent(recorder, "provider.error", {
          provider: opts.provider,
          model: opts.model,
          ordinal,
          traceId: span.traceId,
          spanId: span.spanId,
          message: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : undefined,
        });
        throw err;
      }

      const requestId = providerRequestId(res.headers);
      span.setAttributes({
        "http.response.status_code": res.status,
        "openacme.provider.response_ok": res.ok,
        "openacme.provider.request_id": requestId,
      });
      safeRecordEvent(recorder, "provider.response", {
        provider: opts.provider,
        model: opts.model,
        ordinal,
        status: res.status,
        ok: res.ok,
        headers: redactHeaders(res.headers),
        providerRequestId: requestId,
        traceId: span.traceId,
        spanId: span.spanId,
        ...buildForensicLocatorPayload(responseLocator),
      });
      return res;
    },
    { kind: "client" },
  );
}

function nextOrdinal(key: string): number {
  const next = (providerRequestOrdinals.get(key) ?? 0) + 1;
  providerRequestOrdinals.set(key, next);
  return next;
}

function providerRequestDir(
  ordinal: number,
  provider: string,
  model: string,
): string {
  return `provider-requests/${ordinal}-${safeSegment(provider)}-${safeSegment(model)}`;
}

function safeRecordEvent(
  recorder: ForensicRecorder,
  type: string,
  data: Record<string, unknown>,
): void {
  try {
    recorder.recordEvent(type, data);
  } catch {
    // Observability sinks must never change provider request behavior.
  }
}

function headersFromInit(
  headers: ConstructorParameters<typeof Headers>[0],
): Headers {
  try {
    return new Headers(headers);
  } catch {
    return new Headers();
  }
}

function providerRequestId(headers: Headers): string | undefined {
  return (
    headers.get("x-request-id") ??
    headers.get("openai-request-id") ??
    headers.get("request-id") ??
    undefined
  );
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function bodyPresence(body: unknown): { present: boolean; kind?: string } {
  if (body === undefined || body === null) return { present: false };
  if (typeof body === "string") return { present: true, kind: "string" };
  if (Buffer.isBuffer(body)) return { present: true, kind: "buffer" };
  if (body instanceof URLSearchParams) {
    return { present: true, kind: "url_search_params" };
  }
  if (body instanceof ArrayBuffer)
    return { present: true, kind: "array_buffer" };
  if (ArrayBuffer.isView(body))
    return { present: true, kind: "array_buffer_view" };
  if (body instanceof Blob) return { present: true, kind: "blob" };
  if (body instanceof ReadableStream) return { present: true, kind: "stream" };
  return { present: true, kind: typeof body };
}
