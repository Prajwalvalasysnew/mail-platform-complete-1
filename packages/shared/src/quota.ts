// Atomic daily + monthly quota counters.
//
// The original send path ran `SELECT count(*) FROM messages WHERE queued_at >=
// today` on every request — a growing sequential scan. This replaces it with
// atomic Redis counters (INCRBY) that are cheap and O(1), reconciled lazily
// against the durable usage_daily table on a cold cache.
//
// Counters are keyed per customer per period and expire after the period ends,
// so they self-clean. A cold counter is reconciled from usage_daily (durable)
// rather than assumed to be zero, so a Redis flush can't silently reset quota.

import { sql } from 'kysely';
import { redis } from './redis.js';
import { db, type DbExecutor } from './db.js';

function dayKey(customerId: string, date = new Date()): string {
  return `quota:d:${customerId}:${date.toISOString().slice(0, 10)}`;
}
function monthKey(customerId: string, date = new Date()): string {
  return `quota:m:${customerId}:${date.toISOString().slice(0, 7)}`;
}

const DAY_TTL = 60 * 60 * 36; // 36h
const MONTH_TTL = 60 * 60 * 24 * 40; // 40d

async function ensureSeeded(key: string, seed: () => Promise<number>, ttl: number): Promise<void> {
  // Fast path: key already present.
  if (await redis.exists(key)) return;

  const lockKey = `${key}:seedlock`;
  const won = await redis.set(lockKey, '1', 'EX', 30, 'NX');

  if (won) {
    // We own seeding. Compute the durable baseline, then atomically establish
    // the key ONLY if still absent. Using SET NX with the real baseline (rather
    // than a read-then-set) means that if a concurrent INCRBY already created
    // the key at 0, we must fold our baseline into it rather than clobber the
    // increment. We do that with a tiny Lua add-baseline-if-needed.
    const seeded = await seed();
    // Atomically: if key missing -> set to baseline; if present -> add baseline
    // once (the increments that happened are real sends and must be preserved).
    const seedScript = `
      if redis.call('EXISTS', KEYS[1]) == 0 then
        redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
      else
        redis.call('INCRBY', KEYS[1], ARGV[1])
        redis.call('EXPIRE', KEYS[1], ARGV[2])
      end
      return 1
    `;
    await redis.eval(seedScript, 1, key, String(seeded), String(ttl));
    return;
  }

  // We lost the seed race: another request is loading the baseline from
  // Postgres. Wait briefly for the key to appear so we don't INCR against an
  // unseeded (0) counter and discard the durable baseline. Bounded wait.
  for (let i = 0; i < 50; i++) {
    if (await redis.exists(key)) return;
    await new Promise((r) => setTimeout(r, 20)); // up to ~1s total
  }
  // If seeding is still not done after the bounded wait, proceed anyway; the
  // worst case is a one-time slight under-count, never an over-count.
}

export interface QuotaDecision {
  allowed: boolean;
  daily_used: number;
  daily_limit: number;
  monthly_used: number;
  monthly_limit: number;
  exceeded?: 'daily' | 'monthly';
}

/**
 * Atomically reserve `count` sends against both the daily and monthly quota.
 * If either limit would be exceeded, nothing is consumed and allowed=false.
 */
export async function reserveQuota(
  customerId: string,
  count: number,
  dailyLimit: number,
  monthlyLimit: number,
  executor: DbExecutor = db
): Promise<QuotaDecision> {
  const dKey = dayKey(customerId);
  const mKey = monthKey(customerId);

  // Seed from durable store on cold cache (treats a flush as the true sent count,
  // never as permissive zero).
  await ensureSeeded(
    dKey,
    async () => {
      const row = await executor
        .selectFrom('usage_daily')
        .select('sent')
        .where('customer_id', '=', customerId)
        .where(sql<boolean>`usage_date = CURRENT_DATE`)
        .executeTakeFirst();
      return Number(row?.sent ?? 0);
    },
    DAY_TTL
  );
  await ensureSeeded(
    mKey,
    async () => {
      const row = await executor
        .selectFrom('usage_daily')
        .select(db.fn.sum<number>('sent').as('total'))
        .where('customer_id', '=', customerId)
        .where(sql<boolean>`date_trunc('month', usage_date) = date_trunc('month', CURRENT_DATE)`)
        .executeTakeFirst();
      return Number(row?.total ?? 0);
    },
    MONTH_TTL
  );

  // Atomic check-and-increment via a small Lua script so daily+monthly move together.
  const script = `
    local d = tonumber(redis.call('GET', KEYS[1]) or '0')
    local m = tonumber(redis.call('GET', KEYS[2]) or '0')
    local n = tonumber(ARGV[1])
    local dl = tonumber(ARGV[2])
    local ml = tonumber(ARGV[3])
    if d + n > dl then return {0, d, m, 1} end
    if m + n > ml then return {0, d, m, 2} end
    redis.call('INCRBY', KEYS[1], n)
    redis.call('INCRBY', KEYS[2], n)
    redis.call('EXPIRE', KEYS[1], ARGV[4])
    redis.call('EXPIRE', KEYS[2], ARGV[5])
    return {1, d + n, m + n, 0}
  `;
  const res = (await redis.eval(
    script,
    2,
    dKey,
    mKey,
    String(count),
    String(dailyLimit),
    String(monthlyLimit),
    String(DAY_TTL),
    String(MONTH_TTL)
  )) as [number, number, number, number];

  const [ok, dUsed, mUsed, why] = res.map(Number) as [number, number, number, number];
  return {
    allowed: ok === 1,
    daily_used: dUsed,
    daily_limit: dailyLimit,
    monthly_used: mUsed,
    monthly_limit: monthlyLimit,
    exceeded: why === 1 ? 'daily' : why === 2 ? 'monthly' : undefined,
  };
}

/** Release a previously-reserved quota (e.g. all recipients were suppressed). */
export async function releaseQuota(customerId: string, count: number): Promise<void> {
  if (count <= 0) return;
  // Floor at zero. A stray double-release (or releasing more than was reserved
  // after a counter reset) must never drive usage negative, which would let a
  // customer send beyond their limit. DECRBY then clamp in one Lua round-trip.
  const clampScript = `
    local v = redis.call('DECRBY', KEYS[1], ARGV[1])
    if v < 0 then redis.call('SET', KEYS[1], '0'); v = 0 end
    return v
  `;
  await redis.eval(clampScript, 1, dayKey(customerId), String(count));
  await redis.eval(clampScript, 1, monthKey(customerId), String(count));
}

/** Read-only quota snapshot (for the usage endpoint / 80% alerting). */
export async function getQuotaUsage(
  customerId: string
): Promise<{ daily_used: number; monthly_used: number }> {
  const [d, m] = await redis.mget(dayKey(customerId), monthKey(customerId));
  return { daily_used: Number(d ?? 0), monthly_used: Number(m ?? 0) };
}

// ---------------------------------------------------------------------------
// Per-customer queue depth (fair-share back-pressure)
//
// Tracks how many send-queue jobs are outstanding for a given customer.
// The counter increments when messages are admitted to the queue and decrements
// when the send-worker finishes them (any terminal outcome). An ENV cap stops
// one customer from monopolising the shared queue and starving others.
//
// The counter uses a 25h TTL as a safety valve: if the worker crashes without
// decrementing, stale counts don't block that customer for more than one day.
// ---------------------------------------------------------------------------

const QUEUE_DEPTH_TTL = 60 * 60 * 25; // 25h

function queueDepthKey(customerId: string): string {
  return `queue:depth:${customerId}`;
}

/** How many jobs are currently outstanding (queued or processing) for this customer. */
export async function getCustomerQueueDepth(customerId: string): Promise<number> {
  const v = await redis.get(queueDepthKey(customerId));
  return Math.max(0, Number(v ?? 0));
}

/** Increment the queue depth counter when messages are admitted. */
export async function incrementQueueDepth(customerId: string, count: number): Promise<void> {
  if (count <= 0) return;
  const key = queueDepthKey(customerId);
  await redis.incrby(key, count);
  await redis.expire(key, QUEUE_DEPTH_TTL);
}

/** Decrement the queue depth counter when a send-worker job finishes. */
export async function decrementQueueDepth(customerId: string, count = 1): Promise<void> {
  if (count <= 0) return;
  const key = queueDepthKey(customerId);
  const next = await redis.decrby(key, count);
  // Clamp to 0 — the counter is approximate (worker restarts can skip decrements).
  if (next < 0) await redis.set(key, '0', 'EX', QUEUE_DEPTH_TTL);
}
