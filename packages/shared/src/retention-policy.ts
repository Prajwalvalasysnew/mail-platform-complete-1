// Per-tenant retention window resolution (DATABASE_10_10_PLAN Phase 2.1).
//
// Effective windows resolve: customer override → active subscription's plan
// value → platform default. Two different clamps apply:
//   - events: LEAST(resolved, platform default). The platform events window is
//     a PHYSICAL ceiling (partitions past it are dropped), so a tenant window
//     can only tighten it. Offering a longer window (enterprise 365d) means
//     raising RETENTION_EVENT_DAYS itself — the ceiling is physical.
//   - body: LEAST(resolved, message-row window). Bodies are purged per-tenant,
//     so a plan may extend the body window up to the metadata row's lifetime.
//
// `explicit` is true when the tenant has any plan/override value. Logical
// read-visibility filtering (messages list, activity, analytics) applies ONLY
// to explicit windows, so tenants without a configured plan keep exactly the
// platform's physical behavior — no surprise history loss for existing users.

import { sql } from 'kysely';
import { db } from './db.js';
import type { DbExecutor } from './db.js';

export interface TenantRetentionWindows {
  eventsDays: number;
  bodyDays: number;
  /** True when a plan value or customer override produced these windows. */
  explicit: boolean;
}

export interface RetentionPolicyDefaults {
  eventsDays: number;
  bodyDays: number;
  messageDays: number;
}

export function platformRetentionDefaults(): RetentionPolicyDefaults {
  return {
    eventsDays: Number(process.env.RETENTION_EVENT_DAYS ?? 90),
    bodyDays: Number(process.env.RETENTION_BODY_DAYS ?? 90),
    messageDays: Number(process.env.RETENTION_MESSAGE_DAYS ?? 395),
  };
}

// Subscription statuses whose plan defines the tenant's current entitlement.
const ENTITLED_STATUSES = sql.join(['active', 'trialing', 'past_due']);

/**
 * SQL fragment: one row per customer with the resolved (and clamped)
 * `events_days` / `body_days` windows plus `explicit`. Used as a CTE body by
 * the retention sweep so windows resolve inside the same statement as the
 * purge — this and resolveTenantRetention() must express the same policy.
 */
export function tenantRetentionWindowsSql(d: RetentionPolicyDefaults) {
  return sql`
    SELECT c.id AS customer_id,
           LEAST(COALESCE(c.events_retention_days, plan.events_retention_days, ${d.eventsDays}), ${d.eventsDays}) AS events_days,
           LEAST(COALESCE(c.body_retention_days, plan.body_retention_days, ${d.bodyDays}), ${d.messageDays}) AS body_days,
           (COALESCE(c.events_retention_days, c.body_retention_days,
                     plan.events_retention_days, plan.body_retention_days) IS NOT NULL) AS explicit
    FROM customers c
    LEFT JOIN LATERAL (
      SELECT bp.events_retention_days, bp.body_retention_days
      FROM subscriptions s
      JOIN billing_plans bp ON bp.plan_key = s.plan
      WHERE s.customer_id = c.id AND s.status IN (${ENTITLED_STATUSES})
      ORDER BY s.created_at DESC
      LIMIT 1
    ) plan ON TRUE
  `;
}

// Small TTL cache so API reads don't add a resolution query per request.
const cache = new Map<string, { value: TenantRetentionWindows; expires: number }>();
const CACHE_TTL_MS = 60_000;

/** Test/ops hook: drop cached windows (e.g. after changing a plan). */
export function clearRetentionPolicyCache(): void {
  cache.clear();
}

export async function resolveTenantRetention(
  customerId: string,
  executor: DbExecutor = db,
  defaults: RetentionPolicyDefaults = platformRetentionDefaults(),
): Promise<TenantRetentionWindows> {
  const cached = cache.get(customerId);
  if (cached && cached.expires > Date.now()) return cached.value;

  const res = await sql<{
    events_days: number;
    body_days: number;
    explicit: boolean;
  }>`
    SELECT events_days, body_days, explicit
    FROM (${tenantRetentionWindowsSql(defaults)}) w
    WHERE w.customer_id = ${customerId}
  `.execute(executor);

  const row = res.rows[0];
  const value: TenantRetentionWindows = row
    ? { eventsDays: Number(row.events_days), bodyDays: Number(row.body_days), explicit: Boolean(row.explicit) }
    : { eventsDays: defaults.eventsDays, bodyDays: defaults.bodyDays, explicit: false };
  cache.set(customerId, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * The visibility floor for API reads: a Date before which history is hidden,
 * or null when the tenant has no explicit window (keep platform behavior).
 */
export async function retentionVisibilityCutoff(
  customerId: string,
  executor: DbExecutor = db,
): Promise<Date | null> {
  const w = await resolveTenantRetention(customerId, executor);
  if (!w.explicit) return null;
  return new Date(Date.now() - w.eventsDays * 86_400_000);
}
