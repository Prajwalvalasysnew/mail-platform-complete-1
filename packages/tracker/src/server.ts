// Tracker process entrypoint: start tracing, bind the port, shut down cleanly.
//
// All routes live in app.ts, which exports the Fastify instance without
// listening so tests can exercise the real unsubscribe flow through inject().

import { closeDb, closeQueues, startTracing, stopTracing } from '@platform/shared';

startTracing('mail-tracker');

const { app } = await import('./app.js');

const PORT = Number(process.env.TRACKER_PORT ?? 4000);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down tracker');
  await app.close();
  await closeQueues();
  await closeDb();
  await stopTracing();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await app.listen({ port: PORT, host: '0.0.0.0' });
app.log.info(`Tracker listening on port ${PORT}`);
