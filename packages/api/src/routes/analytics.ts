import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sql } from 'kysely';
import { db } from '@platform/shared';
import { requireScope } from '../plugins/scope.js';
import { tenantScoped } from '../lib/tenant.js';

const PeriodParam = z.enum(['24h', '7d', '30d']).default('7d');
const GranularityParam = z.enum(['hour', 'day']).default('day');
const ByParam = z.enum(['tag', 'domain', 'template']);

function periodToInterval(period: '24h' | '7d' | '30d') {
  // Return a parameter-free, static SQL fragment per allowed period. Avoids ever
  // interpolating a string into sql.raw, so the query is injection-proof by
  // construction even if the caller's validation is later weakened.
  if (period === '24h') return sql`interval '24 hours'`;
  if (period === '7d') return sql`interval '7 days'`;
  return sql`interval '30 days'`;
}

// date_trunc unit as a static fragment keyed off the validated granularity.
function truncUnit(granularity: 'hour' | 'day') {
  return granularity === 'hour' ? sql`'hour'` : sql`'day'`;
}

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  // Summary stats for the authenticated customer over a time period.
  app.get(
    '/analytics/summary',
    { preHandler: requireScope('messages') },
    async (req) => {
      const auth = req.auth!;
      const { period } = z.object({ period: PeriodParam }).parse(req.query);
      const interval = periodToInterval(period);

      const eventRows = await tenantScoped(req, (trx) =>
        trx
          .selectFrom('events')
          .select(['event_type', db.fn.countAll<number>().as('count')])
          .where('customer_id', '=', auth.customer_id)
          .where(sql<boolean>`occurred_at >= now() - ${interval}`)
          .groupBy('event_type')
          .execute()
      );

      const counts: Record<string, number> = {};
      for (const r of eventRows) counts[r.event_type] = Number(r.count);

      const sent = counts['queued'] ?? 0;
      const delivered = counts['delivered'] ?? 0;
      const bounced = (counts['hard_bounce'] ?? 0) + (counts['soft_bounce'] ?? 0);
      const complained = counts['complaint'] ?? 0;
      const opened = counts['opened'] ?? 0;
      const clicked = counts['clicked'] ?? 0;
      const unsubscribed = counts['unsubscribed'] ?? 0;

      return {
        period,
        sent,
        delivered,
        bounced,
        complained,
        opened,
        clicked,
        unsubscribed,
        delivery_rate: sent > 0 ? Number((delivered / sent).toFixed(4)) : 0,
        open_rate: delivered > 0 ? Number((opened / delivered).toFixed(4)) : 0,
        click_rate: delivered > 0 ? Number((clicked / delivered).toFixed(4)) : 0,
      };
    }
  );

  // Time-series: hourly or daily event counts for charting.
  app.get(
    '/analytics/timeseries',
    { preHandler: requireScope('messages') },
    async (req) => {
      const auth = req.auth!;
      const { period, granularity } = z
        .object({ period: z.enum(['7d', '30d']).default('7d'), granularity: GranularityParam })
        .parse(req.query);
      const interval = periodToInterval(period);
      const trunc = truncUnit(granularity);

      const rows = await tenantScoped(req, (trx) =>
        trx
          .selectFrom('events')
          .select([
            sql<string>`date_trunc(${trunc}, occurred_at)`.as('bucket'),
            'event_type',
            db.fn.countAll<number>().as('count'),
          ])
          .where('customer_id', '=', auth.customer_id)
          .where(sql<boolean>`occurred_at >= now() - ${interval}`)
          .groupBy([sql`date_trunc(${trunc}, occurred_at)`, 'event_type'])
          .orderBy(sql`date_trunc(${trunc}, occurred_at)`, 'asc')
          .execute()
      );

      // Pivot into per-bucket objects
      const buckets = new Map<string, Record<string, number>>();
      for (const r of rows) {
        const key = String(r.bucket);
        if (!buckets.has(key)) buckets.set(key, {});
        buckets.get(key)![r.event_type] = Number(r.count);
      }

      const series = Array.from(buckets.entries()).map(([date, ev]) => ({
        date,
        sent: ev['queued'] ?? 0,
        delivered: ev['delivered'] ?? 0,
        bounced: (ev['hard_bounce'] ?? 0) + (ev['soft_bounce'] ?? 0),
        opened: ev['opened'] ?? 0,
        clicked: ev['clicked'] ?? 0,
      }));

      return { granularity, series };
    }
  );

  // Breakdown by tag, from-domain, or template.
  app.get(
    '/analytics/breakdown',
    { preHandler: requireScope('messages') },
    async (req) => {
      const auth = req.auth!;
      const { by, period } = z
        .object({ by: ByParam, period: PeriodParam })
        .parse(req.query);
      const interval = periodToInterval(period);

      const rows = await tenantScoped(req, async (trx) => {
        if (by === 'tag') {
          const rawRows = await trx
            .selectFrom('events')
            .innerJoin('messages', 'messages.message_id', 'events.message_id')
            .select([
              sql<string>`unnest(messages.tags)`.as('key'),
              'events.event_type',
              db.fn.countAll<number>().as('count'),
            ])
            .where('events.customer_id', '=', auth.customer_id)
            .where(sql<boolean>`events.occurred_at >= now() - ${interval}`)
            .groupBy([sql`unnest(messages.tags)`, 'events.event_type'])
            .execute();
          return rawRows.map((r) => ({ key: r.key, event_type: r.event_type, count: Number(r.count) }));
        } else if (by === 'domain') {
          const rawRows = await trx
            .selectFrom('events')
            .innerJoin('messages', 'messages.message_id', 'events.message_id')
            .select([
              sql<string>`split_part(messages.from_address, '@', 2)`.as('key'),
              'events.event_type',
              db.fn.countAll<number>().as('count'),
            ])
            .where('events.customer_id', '=', auth.customer_id)
            .where(sql<boolean>`events.occurred_at >= now() - ${interval}`)
            .groupBy([sql`split_part(messages.from_address, '@', 2)`, 'events.event_type'])
            .execute();
          return rawRows.map((r) => ({ key: r.key, event_type: r.event_type, count: Number(r.count) }));
        } else {
          // by === 'template'
          const rawRows = await trx
            .selectFrom('events')
            .innerJoin('messages', 'messages.message_id', 'events.message_id')
            .select([
              sql<string>`coalesce(messages.template_id::text, 'none')`.as('key'),
              'events.event_type',
              db.fn.countAll<number>().as('count'),
            ])
            .where('events.customer_id', '=', auth.customer_id)
            .where(sql<boolean>`events.occurred_at >= now() - ${interval}`)
            .groupBy([sql`coalesce(messages.template_id::text, 'none')`, 'events.event_type'])
            .execute();
          return rawRows.map((r) => ({ key: r.key, event_type: r.event_type, count: Number(r.count) }));
        }
      });

      // Pivot by key
      const keys = new Map<string, Record<string, number>>();
      for (const r of rows) {
        if (!keys.has(r.key)) keys.set(r.key, {});
        keys.get(r.key)![r.event_type] = r.count;
      }

      const items = Array.from(keys.entries())
        .map(([key, ev]) => ({
          key,
          sent: ev['queued'] ?? 0,
          delivered: ev['delivered'] ?? 0,
          bounced: (ev['hard_bounce'] ?? 0) + (ev['soft_bounce'] ?? 0),
          opened: ev['opened'] ?? 0,
          clicked: ev['clicked'] ?? 0,
        }))
        .sort((a, b) => b.sent - a.sent)
        .slice(0, 100);

      return { by, period, items };
    }
  );
};
