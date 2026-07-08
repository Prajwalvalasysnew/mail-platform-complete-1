import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import { db, getQuotaUsage } from '@platform/shared';
import { requireScope } from '../plugins/scope.js';
import { tenantScoped } from '../lib/tenant.js';

export const usageRoutes: FastifyPluginAsync = async (app) => {
  // Current quota usage + remaining (atomic counters), with threshold flags.
  app.get('/usage/quota', { preHandler: requireScope('messages') }, async (req) => {
    const auth = req.auth!;
    // `customers` is not an RLS-protected table, so this stays on global `db`.
    const customer = await db
      .selectFrom('customers')
      .select(['daily_quota', 'monthly_quota'])
      .where('id', '=', auth.customer_id)
      .executeTakeFirstOrThrow();
    const used = await getQuotaUsage(auth.customer_id);
    const dailyPct = customer.daily_quota > 0 ? used.daily_used / customer.daily_quota : 0;
    const monthlyPct = customer.monthly_quota > 0 ? used.monthly_used / customer.monthly_quota : 0;
    return {
      daily: { used: used.daily_used, limit: customer.daily_quota, remaining: Math.max(0, customer.daily_quota - used.daily_used), pct: Number(dailyPct.toFixed(4)) },
      monthly: { used: used.monthly_used, limit: customer.monthly_quota, remaining: Math.max(0, customer.monthly_quota - used.monthly_used), pct: Number(monthlyPct.toFixed(4)) },
      alerts: {
        daily_80: dailyPct >= 0.8,
        daily_100: dailyPct >= 1,
        monthly_80: monthlyPct >= 0.8,
        monthly_100: monthlyPct >= 1,
      },
    };
  });

  // Daily usage for the last N days
  app.get('/usage', { preHandler: requireScope('messages') }, async (req) => {
    const auth = req.auth!;
    const { days = '30' } = req.query as Record<string, string>;
    const safeDays = (() => {
      const n = parseInt(String(days), 10);
      if (!Number.isFinite(n) || n <= 0) return 30;
      return Math.min(n, 365);
    })();
    const rows = await tenantScoped(req, (trx) =>
      trx
        .selectFrom('usage_daily')
        .select(['usage_date', 'sent', 'delivered', 'bounced', 'complained'])
        .where('customer_id', '=', auth.customer_id)
        .where(sql<boolean>`usage_date >= (CURRENT_DATE - ${safeDays} * INTERVAL '1 day')`)
        .orderBy('usage_date', 'desc')
        .execute()
    );

    const totals = rows.reduce(
      (acc, r) => ({
        sent: acc.sent + r.sent,
        delivered: acc.delivered + r.delivered,
        bounced: acc.bounced + r.bounced,
        complained: acc.complained + r.complained,
      }),
      { sent: 0, delivered: 0, bounced: 0, complained: 0 }
    );

    const deliveryRate = totals.sent > 0 ? totals.delivered / totals.sent : 0;
    const bounceRate = totals.sent > 0 ? totals.bounced / totals.sent : 0;
    const complaintRate = totals.sent > 0 ? totals.complained / totals.sent : 0;

    return {
      daily: rows,
      totals,
      rates: {
        delivery: Number(deliveryRate.toFixed(4)),
        bounce: Number(bounceRate.toFixed(4)),
        complaint: Number(complaintRate.toFixed(4)),
      },
      // Gmail/Yahoo require complaint rate < 0.003 (0.3%)
      health: {
        complaint_ok: complaintRate < 0.003,
        bounce_ok: bounceRate < 0.05,
      },
    };
  });

  // Aggregate stats by event type over a time window
  app.get('/stats', { preHandler: requireScope('messages') }, async (req) => {
    const auth = req.auth!;
    const { days = '7' } = req.query as Record<string, string>;
    const safeDays = (() => {
      const n = parseInt(String(days), 10);
      if (!Number.isFinite(n) || n <= 0) return 7;
      return Math.min(n, 365);
    })();
    const rows = await tenantScoped(req, (trx) =>
      trx
        .selectFrom('events')
        .select(['event_type', db.fn.countAll<number>().as('count')])
        .where('customer_id', '=', auth.customer_id)
        .where(sql<boolean>`occurred_at >= (NOW() - ${safeDays} * INTERVAL '1 day')`)
        .groupBy('event_type')
        .execute()
    );
    return { stats: rows };
  });
};
