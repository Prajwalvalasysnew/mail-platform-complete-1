// Register OpenTelemetry before HTTP, PostgreSQL, Redis, BullMQ, and workers load.
import { startTracing } from '@platform/shared/tracing.js';

startTracing('mail-worker');
await import('./index.js');
