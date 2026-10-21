import { Worker } from 'bullmq';
import type { Logger } from 'pino';
import {
  redisOptions,
  deadLetter,
  deadLetterTotal,
  QUEUE_PREFIX,
  advanceWorkflowRun,
  handleWorkflowWake,
  handleWorkflowTimeout,
  emitWorkflowCustomEvent,
  type WorkflowJobData,
} from '@platform/shared';

/**
 * Drives workflow-run state machines. Every handler is idempotent against the
 * workflow_runs row (the durable source of truth), so BullMQ retries, sweep
 * re-arms, and event/timeout races all collapse into no-ops.
 */
export function startWorkflowWorker(logger: Logger) {
  const worker = new Worker<WorkflowJobData>(
    `${QUEUE_PREFIX}workflow`,
    async (job) => {
      const { kind, run_id, step_id } = job.data;
      const log = logger.child({ workflow_run_id: run_id, kind });
      switch (kind) {
        case 'advance':
          await advanceWorkflowRun(run_id);
          break;
        case 'wake':
          await handleWorkflowWake(run_id);
          break;
        case 'timeout':
          await handleWorkflowTimeout(run_id, step_id);
          break;
        case 'custom_event':
          await emitWorkflowCustomEvent({ customerId: job.data.customer_id, name: job.data.event_name!, subjectEmail: job.data.subject_email!, data: job.data.data });
          break;
        default:
          log.warn('unknown workflow job kind — dropping');
      }
    },
    {
      connection: redisOptions,
      concurrency: Number(process.env.WORKFLOW_WORKER_CONCURRENCY ?? 10),
    }
  );

  worker.on('failed', async (job, err) => {
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts?.attempts ?? 1;
    if (job && attemptsMade >= maxAttempts) {
      logger.error(
        { job_id: job.id, run_id: job.data?.run_id, kind: job.data?.kind, err: err.message, attemptsMade },
        'workflow job exhausted retries — dead-lettering'
      );
      try {
        await deadLetter('workflow', job, err.message);
        deadLetterTotal.inc({ source_queue: 'workflow' });
      } catch (dlErr: any) {
        logger.error({ err: dlErr?.message }, 'failed to dead-letter workflow job');
      }
    } else {
      logger.warn({ job_id: job?.id, err: err.message, attemptsMade }, 'workflow job failed (will retry)');
    }
  });

  return worker;
}
