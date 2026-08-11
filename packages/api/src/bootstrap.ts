// Register OpenTelemetry before Fastify, HTTP, PostgreSQL, and Redis load.
import { startTracing } from '@platform/shared/tracing.js';

startTracing('mail-api');
await import('./server.js');
