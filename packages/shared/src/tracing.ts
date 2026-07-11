// OpenTelemetry tracing. Spans flow API -> queue -> worker -> Haraka so a slow
// send can be debugged end-to-end. Span-creation (startSpan/withSpan) uses the
// global tracer unconditionally: when no SDK provider is registered, the OTel
// API returns non-recording (no-op) spans, so local/dev runs have zero tracing
// overhead. startTracing() registers the real NodeSDK + OTLP exporter and is a
// no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set.

import { trace, context, propagation, ROOT_CONTEXT, SpanStatusCode, type Span as OtelSpan, type Attributes } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { sanitizeTelemetryText } from './logging.js';

const TRACER_NAME = 'mail-platform';

/** Narrow span surface the rest of the codebase depends on. */
export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(err: unknown): void;
  end(): void;
}

function adapt(span: OtelSpan): Span {
  return {
    setAttribute: (k, v) => { span.setAttribute(k, v); },
    recordException: (err) => {
      const original = err instanceof Error ? err.message : String(err);
      const e = new Error(sanitizeTelemetryText(original));
      span.recordException(e);
      span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
    },
    end: () => { span.end(); },
  };
}

/** Create a span. No-op (non-recording) unless a tracer provider is registered. */
export function startSpan(name: string, attrs?: Record<string, string | number | boolean>): Span {
  const span = trace.getTracer(TRACER_NAME).startSpan(name, attrs ? { attributes: attrs as Attributes } : undefined);
  return adapt(span);
}

/**
 * Run an async fn inside an active span: child spans nest under it, exceptions
 * are recorded and set the span status to ERROR, and the span always ends.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attrs?: Record<string, string | number | boolean>
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return await tracer.startActiveSpan(name, attrs ? { attributes: attrs as Attributes } : {}, async (otelSpan) => {
    const span = adapt(otelSpan);
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err);
      throw err;
    } finally {
      otelSpan.end();
    }
  });
}

let sdk: NodeSDK | null = null;

/**
 * Initialize real tracing. No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set, so
 * dev/test runs pay nothing. Auto-instruments outbound/inbound HTTP, Postgres
 * (pg) and Redis (ioredis); manual spans (withSpan) work regardless of load
 * order. Idempotent.
 */
export function startTracing(serviceName: string): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;
  if (sdk) return;
  sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [
      new HttpInstrumentation(),
      new PgInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });
  sdk.start();
  // eslint-disable-next-line no-console
  console.log(`[otel] tracing enabled for ${serviceName} -> ${endpoint}`);
}

/**
 * Inject the active W3C trace context (traceparent + tracestate) into a
 * carrier object.  Pass the carrier in a BullMQ job's data so the worker can
 * continue the distributed trace.  No-op when tracing is disabled.
 */
export function injectTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/**
 * Extract a W3C trace context from a carrier object and return a context
 * that is a child of the remote span.  Pass to `context.with()` before doing
 * work in the worker so spans appear under the originating API request.
 */
export function extractTraceContext(carrier: Record<string, string> | undefined) {
  if (!carrier || Object.keys(carrier).length === 0) return ROOT_CONTEXT;
  return propagation.extract(ROOT_CONTEXT, carrier);
}

/** Run an async fn with the given remote trace context active (for workers). */
export async function withRemoteContext<T>(
  carrier: Record<string, string> | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const ctx = extractTraceContext(carrier);
  return context.with(ctx, fn);
}

/** Flush and shut down the tracer on graceful exit. Safe to call when disabled. */
export async function stopTracing(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    /* best-effort flush on shutdown */
  } finally {
    sdk = null;
  }
}
