import { Queue, type QueueOptions, type BackoffStrategy } from 'bullmq';
import { redisOptions } from './redis.js';

// Allow tests to use an isolated namespace so Docker worker jobs don't
// interfere with in-process test workers.  Set QUEUE_PREFIX=test_ in tests.
export const QUEUE_PREFIX = process.env.QUEUE_PREFIX ?? '';

const defaultQueueOpts: QueueOptions = {
  connection: redisOptions,
  defaultJobOptions: {
    removeOnComplete: { age: 86_400, count: 10_000 }, // keep 24h or last 10k
    removeOnFail: { age: 7 * 86_400 },                // keep 7d on fail
    attempts: 5,
    backoff: { type: 'exponential', delay: 60_000 },  // 1m, 2m, 4m, 8m, 16m
  },
};

// =====================================================
// Send queue — API enqueues, worker pulls and ships to Haraka
// =====================================================
export interface SendJobData {
  message_id: string;
  customer_id: string;
  priority?: number;
}

export const sendQueue = new Queue<SendJobData>(`${QUEUE_PREFIX}send`, defaultQueueOpts);

// =====================================================
// Events queue — Haraka plugins publish, event worker consumes
// =====================================================
export interface EventJobData {
  message_id: string;
  customer_id?: string;
  event_type:
    | 'queued'
    | 'failed'
    | 'delivered'
    | 'soft_bounce'
    | 'hard_bounce'
    | 'complaint'
    | 'opened'
    | 'clicked'
    | 'unsubscribed';
  payload?: Record<string, unknown>;
  ip?: string;
  user_agent?: string;
  occurred_at?: string;
  // Open/click bot-detection verdict (set by the tracker for opened/clicked).
  bot_verdict?: 'human' | 'bot' | 'suspicious';
  bot_score?: number;
  bot_reasons?: string[];
  // Optional producer-supplied idempotency key (UUID). When set, the event
  // worker dedupes retries of the same logical event so usage isn't
  // double-counted. Set it on usage-affecting events (delivered, bounces,
  // complaints).
  event_key?: string;
}

export const eventsQueue = new Queue<EventJobData>(`${QUEUE_PREFIX}events`, defaultQueueOpts);

// =====================================================
// Webhooks queue — fires customer webhook URLs
// =====================================================
export interface WebhookJobData {
  webhook_id: string;
  event_id: number | string;
  event_type: string;
  payload: Record<string, unknown>;
}

// Webhook deliveries get a much longer, capped-exponential retry window than
// the platform default (which is tuned for internal queues, not third-party
// HTTP endpoints). A customer's webhook receiver can be down for a deploy,
// cert renewal, or provider incident lasting hours — retrying for only ~31
// minutes (the old 5-attempt default) drops real events that a longer retry
// window would have delivered. This targets roughly a day of retry coverage,
// in line with major ESB/webhook providers (doubling 1m -> capped at 4h):
//   1m, 2m, 4m, 8m, 16m, 32m, 64m, 128m, 4h, 4h, 4h, 4h  (~20h total, 12 attempts)
const WEBHOOK_BACKOFF_BASE_MS = 60_000;
const WEBHOOK_BACKOFF_CAP_MS = 4 * 3600_000;
export const webhookBackoffStrategy: BackoffStrategy = (attemptsMade: number) => {
  const uncapped = WEBHOOK_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attemptsMade - 1));
  return Math.min(uncapped, WEBHOOK_BACKOFF_CAP_MS);
};

export const webhooksQueue = new Queue<WebhookJobData>(`${QUEUE_PREFIX}webhooks`, {
  ...defaultQueueOpts,
  defaultJobOptions: {
    ...defaultQueueOpts.defaultJobOptions,
    attempts: Number(process.env.WEBHOOK_MAX_RETRIES ?? 12),
    backoff: { type: 'custom' },
  },
});

// =====================================================
// Dead-letter queue — jobs that exhausted all retries land here for
// inspection / manual replay instead of vanishing. Nothing consumes it
// automatically; an operator (or a future reaper) drains it.
// =====================================================
export interface DeadLetterJobData {
  source_queue: string;
  original_job_id?: string;
  data: unknown;
  failed_reason: string;
  attempts_made: number;
  dead_lettered_at: string;
}

export const deadLetterQueue = new Queue<DeadLetterJobData>(`${QUEUE_PREFIX}dead-letter`, {
  connection: redisOptions,
  defaultJobOptions: {
    removeOnComplete: false,
    removeOnFail: false,
  },
});

/**
 * Move a permanently-failed job to the dead-letter queue. Call from a worker's
 * 'failed' handler when job.attemptsMade >= job.opts.attempts.
 */
export async function deadLetter(
  sourceQueue: string,
  job: { id?: string; data: unknown; attemptsMade?: number } | undefined,
  reason: string
): Promise<void> {
  await deadLetterQueue.add('dead', {
    source_queue: sourceQueue,
    original_job_id: job?.id,
    data: job?.data,
    failed_reason: reason,
    attempts_made: job?.attemptsMade ?? 0,
    dead_lettered_at: new Date().toISOString(),
  });
}

const DEAD_LETTER_JOB_TYPES = ['waiting', 'delayed', 'failed', 'paused', 'completed'] as const;
type DeadLetterJobType = (typeof DEAD_LETTER_JOB_TYPES)[number];

export interface DeadLetterListItem {
  id: string;
  original_job_id?: string;
  source_queue: string;
  failed_reason: string;
  attempts_made: number;
  dead_lettered_at: string;
  payload: unknown;
}

export interface DeadLetterDetail extends DeadLetterListItem {
  payload: unknown;
  state: string;
}

function truncatePayload(payload: unknown, maxBytes: number): unknown {
  const json = JSON.stringify(payload);
  if (!json || json.length <= maxBytes) return payload;
  return {
    truncated: true,
    bytes: json.length,
    preview: json.slice(0, maxBytes),
  };
}

async function toDeadLetterListItem(job: any, maxPayloadBytes: number): Promise<DeadLetterListItem> {
  const data = job.data as DeadLetterJobData;
  return {
    id: String(job.id),
    original_job_id: data.original_job_id,
    source_queue: data.source_queue,
    failed_reason: data.failed_reason,
    attempts_made: data.attempts_made,
    dead_lettered_at: data.dead_lettered_at,
    payload: truncatePayload(data.data, maxPayloadBytes),
  };
}

function queueForReplay(sourceQueue: string) {
  if (sourceQueue === 'send') return { queue: sendQueue, name: 'send' };
  if (sourceQueue === 'events') return { queue: eventsQueue, name: 'event' };
  if (sourceQueue === 'webhooks') return { queue: webhooksQueue, name: 'deliver' };
  throw new Error(`unsupported_source_queue:${sourceQueue}`);
}

export async function listDeadLetter(opts: {
  limit?: number;
  offset?: number;
  maxPayloadBytes?: number;
} = {}): Promise<{ jobs: DeadLetterListItem[]; limit: number; offset: number; total: number }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const offset = Math.max(0, opts.offset ?? 0);
  const maxPayloadBytes = Math.max(100, Math.min(opts.maxPayloadBytes ?? 1000, 10_000));
  const end = offset + limit - 1;
  const [jobs, counts] = await Promise.all([
    deadLetterQueue.getJobs([...DEAD_LETTER_JOB_TYPES] as DeadLetterJobType[], offset, end, false),
    deadLetterQueue.getJobCounts(...DEAD_LETTER_JOB_TYPES),
  ]);
  const total = Object.values(counts).reduce((sum, n) => sum + Number(n ?? 0), 0);
  return {
    jobs: await Promise.all(jobs.map((job) => toDeadLetterListItem(job, maxPayloadBytes))),
    limit,
    offset,
    total,
  };
}

export async function getDeadLetter(id: string): Promise<DeadLetterDetail | null> {
  const job = await deadLetterQueue.getJob(id);
  if (!job) return null;
  const item = await toDeadLetterListItem(job, Number.MAX_SAFE_INTEGER);
  return {
    ...item,
    state: await job.getState(),
  };
}

export async function replayDeadLetter(id: string): Promise<{ replayed: boolean; id: string; source_queue: string; new_job_id?: string } | null> {
  const job = await deadLetterQueue.getJob(id);
  if (!job) return null;
  const data = job.data as DeadLetterJobData;
  const target = queueForReplay(data.source_queue);
  const replayed = await target.queue.add(target.name, data.data as any);
  await job.remove();
  return {
    replayed: true,
    id,
    source_queue: data.source_queue,
    new_job_id: String(replayed.id),
  };
}

export async function purgeDeadLetter(id: string): Promise<boolean> {
  const job = await deadLetterQueue.getJob(id);
  if (!job) return false;
  await job.remove();
  return true;
}

export async function purgeAllDeadLetters(): Promise<number> {
  let purged = 0;
  while (true) {
    const jobs = await deadLetterQueue.getJobs([...DEAD_LETTER_JOB_TYPES] as DeadLetterJobType[], 0, 499, false);
    if (jobs.length === 0) return purged;
    for (const job of jobs) {
      await job.remove();
      purged += 1;
    }
  }
}

export const allQueues = [sendQueue, eventsQueue, webhooksQueue, deadLetterQueue];

export async function closeQueues(): Promise<void> {
  await Promise.all(allQueues.map((q) => q.close()));
}
