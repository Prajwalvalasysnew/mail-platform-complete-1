// Exports worker (DATABASE_10_10_PLAN Phase 2.2): consumes the exports queue
// and materializes each data_exports row to NDJSON in the object store.
// runDataExport owns claiming, batching, storage, and terminal status; a job
// throw here only happens on infra errors (DB/store down), which BullMQ
// retries with backoff.
import { Worker } from 'bullmq';
import type { Logger } from 'pino';
import { QUEUE_PREFIX, redisOptions, runDataExport, type ExportJobData } from '@platform/shared';

export function startExportsWorker(logger: Logger): Worker<ExportJobData> {
  const worker = new Worker<ExportJobData>(
    `${QUEUE_PREFIX}exports`,
    async (job) => {
      const result = await runDataExport(job.data.export_id);
      if (!result) {
        logger.info({ export_id: job.data.export_id }, 'export already finished — idempotent skip');
        return;
      }
      if (result.status === 'failed') {
        logger.error({ export_id: result.id, error: result.error }, 'export failed');
        return;
      }
      logger.info(
        { export_id: result.id, rows: result.row_count, bytes: result.size_bytes, truncated: result.truncated },
        'export completed',
      );
    },
    { connection: redisOptions, concurrency: Number(process.env.EXPORT_CONCURRENCY ?? 2) },
  );
  worker.on('failed', (job, err) => {
    logger.error({ export_id: job?.data?.export_id, err: err?.message }, 'export job errored; BullMQ will retry');
  });
  return worker;
}
