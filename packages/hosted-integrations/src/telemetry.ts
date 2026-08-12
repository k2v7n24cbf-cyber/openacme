import {
  SpanStatusCode,
  metrics,
  trace,
  type Attributes,
} from "@opentelemetry/api";

export interface HostedIntegrationTelemetrySpan {
  setAttributes(attributes: Record<string, string | number | boolean>): void;
  addEvent(
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): void;
  recordException(error: unknown): void;
  setStatusOk(): void;
  setStatusError(message: string): void;
}

export interface HostedIntegrationTelemetry {
  withInvocationSpan<T>(
    attributes: Record<string, string | number | boolean>,
    fn: (span: HostedIntegrationTelemetrySpan) => Promise<T>,
  ): Promise<T>;
  recordLargeResponse(
    attributes: Record<string, string | number | boolean>,
  ): void;
}

export function createNoopHostedIntegrationTelemetry(): HostedIntegrationTelemetry {
  const span: HostedIntegrationTelemetrySpan = {
    setAttributes() {},
    addEvent() {},
    recordException() {},
    setStatusOk() {},
    setStatusError() {},
  };
  return {
    withInvocationSpan: (_attributes, fn) => fn(span),
    recordLargeResponse() {},
  };
}

export function createOpenTelemetryHostedIntegrationTelemetry(): HostedIntegrationTelemetry {
  const tracer = trace.getTracer("openacme.hosted-integrations");
  const meter = metrics.getMeter("openacme.hosted-integrations");
  const largeResponseCounter = meter.createCounter(
    "openacme.hosted_integrations.large_responses",
    {
      description:
        "Hosted integration responses returned as artifacts instead of inline content.",
    },
  );
  return {
    withInvocationSpan(attributes, fn) {
      return tracer.startActiveSpan(
        "hosted_integration.invoke",
        { attributes: otelAttributes(attributes) },
        async (span) => {
          const wrapped: HostedIntegrationTelemetrySpan = {
            setAttributes(next) {
              span.setAttributes(otelAttributes(next));
            },
            addEvent(name, next) {
              span.addEvent(name, otelAttributes(next ?? {}));
            },
            recordException(error) {
              span.recordException(error as Error);
            },
            setStatusOk() {
              span.setStatus({ code: SpanStatusCode.OK });
            },
            setStatusError(message) {
              span.setStatus({ code: SpanStatusCode.ERROR, message });
            },
          };
          try {
            return await fn(wrapped);
          } catch (error) {
            wrapped.recordException(error);
            wrapped.setStatusError(error instanceof Error ? error.message : String(error));
            throw error;
          } finally {
            span.end();
          }
        },
      );
    },
    recordLargeResponse(attributes) {
      largeResponseCounter.add(1, otelAttributes(attributes));
    },
  };
}

function otelAttributes(
  attributes: Record<string, string | number | boolean>,
): Attributes {
  return attributes;
}
