// IP warming + pool selection logic.
// Enforces a per-pool daily send cap that ramps up over time, so fresh IPs
// aren't blasted with volume they haven't earned reputation for.

import { db } from './db.js';
import { redis } from './redis.js';

// Standard warmup schedule: max sends allowed per day at each stage.
// Stage advances by 1 per day of successful sending (handled by a cron job).
const WARMUP_SCHEDULE: number[] = [
  50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 20_000, 40_000,
  75_000, 125_000, 200_000, 350_000, 500_000, 750_000, 1_000_000,
];

export function dailyCapForStage(stage: number): number {
  if (stage >= WARMUP_SCHEDULE.length) return Number.MAX_SAFE_INTEGER; // fully warmed
  return WARMUP_SCHEDULE[Math.max(0, stage)]!;
}

/**
 * Check whether a pool can accept `count` more sends today without exceeding
 * its warmup cap. Returns the decision plus current usage.
 */
export async function canSendOnPool(
  poolName: string,
  count: number
): Promise<{ allowed: boolean; cap: number; used: number; remaining: number }> {
  const stageKey = `warmup:stage:${poolName}`;
  const cachedStage = await redis.get(stageKey);
  let stage: number;
  if (cachedStage !== null) {
    stage = Number(cachedStage);
  } else {
    const pool = await db
      .selectFrom('ip_pools')
      .select(['warmup_stage'])
      .where('name', '=', poolName)
      .executeTakeFirst();
    stage = pool?.warmup_stage ?? 0;
    // Stage changes only through the daily advancement below. A short cache
    // removes one database statement from every send; advancement invalidates
    // it immediately.
    await redis.setex(stageKey, 300, String(stage));
  }
  const cap = dailyCapForStage(stage);

  const dayKey = `warmup:${poolName}:${new Date().toISOString().slice(0, 10)}`;
  const used = Number((await redis.get(dayKey)) ?? 0);
  const remaining = Math.max(0, cap - used);

  return { allowed: used + count <= cap, cap, used, remaining };
}

/**
 * Record sends against a pool's daily counter.
 */
export async function recordPoolSends(poolName: string, count: number): Promise<void> {
  const dayKey = `warmup:${poolName}:${new Date().toISOString().slice(0, 10)}`;
  await redis.incrby(dayKey, count);
  await redis.expire(dayKey, 172800); // keep 2 days
}

/**
 * Advance warmup stage for all pools that hit ~80%+ of their cap yesterday
 * (i.e. they're actually sending and ready for more). Run daily via cron.
 */
export async function advanceWarmupStages(): Promise<void> {
  const pools = await db.selectFrom('ip_pools').select(['name', 'warmup_stage']).execute();
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

  for (const pool of pools) {
    if (pool.warmup_stage >= WARMUP_SCHEDULE.length) continue;
    const used = Number((await redis.get(`warmup:${pool.name}:${yesterday}`)) ?? 0);
    const cap = dailyCapForStage(pool.warmup_stage);
    // Advance only if they used at least 80% of capacity (proves real volume)
    if (used >= cap * 0.8) {
      await db
        .updateTable('ip_pools')
        .set({ warmup_stage: pool.warmup_stage + 1 })
        .where('name', '=', pool.name)
        .execute();
      await redis.del(`warmup:stage:${pool.name}`);
    }
  }
}
