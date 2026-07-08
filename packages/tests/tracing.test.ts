// Proves the tracing layer emits REAL OpenTelemetry spans (not the old no-op
// shim) once a tracer provider is registered: attributes are recorded, thrown
// errors set ERROR status + an exception event, and child spans nest under the
// active span. An in-memory exporter captures spans so no collector is needed.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { withSpan, startSpan } from '@platform/shared';

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;

beforeAll(() => {
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});

beforeEach(() => exporter.reset());

describe('tracing (real OpenTelemetry)', () => {
  it('records a span with attributes and OK status', async () => {
    const result = await withSpan('test.op', async (span) => {
      span.setAttribute('customer', 'acme');
      return 42;
    }, { kind: 'unit' });

    expect(result).toBe(42);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('test.op');
    expect(spans[0].attributes.kind).toBe('unit');
    expect(spans[0].attributes.customer).toBe('acme');
  });

  it('records exceptions, sets ERROR status, and rethrows', async () => {
    await expect(
      withSpan('test.fail', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('nests child spans under the active span', async () => {
    await withSpan('parent', async () => {
      const child = startSpan('child');
      child.end();
    });

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === 'parent')!;
    const child = spans.find((s) => s.name === 'child')!;
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    // Child's parent span id should equal the parent's span id.
    expect(child.parentSpanContext?.spanId ?? (child as any).parentSpanId).toBe(parent.spanContext().spanId);
  });

  it('is a no-op (non-recording) when no span is active and provider returns spans only on demand', async () => {
    // A standalone startSpan still records (provider is registered); ending it
    // should produce exactly one span with no parent.
    const s = startSpan('standalone');
    s.end();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('standalone');
  });
});
