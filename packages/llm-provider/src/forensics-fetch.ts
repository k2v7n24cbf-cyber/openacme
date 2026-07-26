import {
  createForensicRecorder,
  redactHeaders,
  sha256Hex,
  type ForensicRecorder,
} from "./forensics-recorder.js";
import { getAIForensicContext } from "./forensics-context.js";
import { withOpenAcmeSpan } from "./observability.js";
import {
  buildForensicEventSelector,
  buildForensicLocatorAttributes,
  buildForensicLocatorPayload,
} from "./evidence-locator.js";

type FetchLike = typeof fetch;

export interface ForensicFetchOptions {
  provider: string;
  model: string;
  authMode?: string;
  preTransformBody?: unknown;
  fetch?: FetchLike;
  recorder?: ForensicRecorder;
}

const providerRequestOrdinals = new Map<string, number>();

export function getAIForensicProviderRequestCount(
  forensicRunId: string | undefined
): number | undefined {
  if (!forensicRunId) return undefined;
  return providerRequestOrdinals.get(forensicRunId);
}

export async function forensicFetch(
  input: Parameters<FetchLike>[0],
  init: Parameters<FetchLike>[1],
  opts: ForensicFetchOptions
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
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const finalBody = await bodyToBuffer(init?.body);
  const preBody = await bodyToBuffer(opts.preTransformBody);

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
      ...(finalBody
        ? {
            "openacme.provider.request_body_bytes": finalBody.byteLength,
            "openacme.provider.request_body_sha256": sha256Hex(finalBody),
          }
        : {}),
      ...(preBody
        ? {
            "openacme.provider.pre_transform_body_bytes": preBody.byteLength,
            "openacme.provider.pre_transform_body_sha256": sha256Hex(preBody),
          }
        : {}),
    },
    async (span) => {
      if (preBody) {
        recorder.writeRawFile(
          `${requestDir}/request.pre-transform.body`,
          preBody
        );
      }
      if (finalBody) {
        recorder.writeRawFile(
          `${requestDir}/request.post-transform.body`,
          finalBody
        );
      }

      recorder.recordEvent("provider.request", {
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
        ...(finalBody
          ? {
              requestBodyBytes: finalBody.byteLength,
              requestBodySha256: sha256Hex(finalBody),
            }
          : {}),
        ...(preBody
          ? {
              preTransformBodyBytes: preBody.byteLength,
              preTransformBodySha256: sha256Hex(preBody),
            }
          : {}),
      });

      let res: Response;
      try {
        res = await (opts.fetch ?? fetch)(input, init);
      } catch (err) {
        recorder.recordEvent("provider.error", {
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
      const responseBody = recorder.enabled
        ? await cloneResponseBody(res)
        : null;
      if (responseBody) {
        recorder.writeRawFile(`${requestDir}/response.body`, responseBody);
      }
      recorder.recordEvent("provider.response", {
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
        ...(responseBody
          ? {
              responseBodyBytes: responseBody.byteLength,
              responseBodySha256: sha256Hex(responseBody),
            }
          : {}),
      });
      return res;
    },
    { kind: "client" }
  );
}

function nextOrdinal(key: string): number {
  const next = (providerRequestOrdinals.get(key) ?? 0) + 1;
  providerRequestOrdinals.set(key, next);
  return next;
}

function providerRequestDir(ordinal: number, provider: string, model: string): string {
  return `provider-requests/${ordinal}-${safeSegment(provider)}-${safeSegment(model)}`;
}

async function bodyToBuffer(body: unknown): Promise<Buffer | null> {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body, "utf-8");
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf-8");
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }
  return null;
}

async function cloneResponseBody(res: Response): Promise<Buffer | null> {
  try {
    return Buffer.from(await res.clone().arrayBuffer());
  } catch {
    return null;
  }
}

function headersFromInit(headers: ConstructorParameters<typeof Headers>[0]): Headers {
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
