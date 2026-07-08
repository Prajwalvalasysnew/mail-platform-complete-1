import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sql } from 'kysely';
import { db, listWebhooks, createWebhook, deleteWebhook, rotateWebhookSecret, webhooksQueue, WebhookError, WEBHOOK_EVENT_TYPES } from '@platform/shared';
import { requireScope } from '../plugins/scope.js';
import { tenantScoped } from '../lib/tenant.js';

const CreateWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1),
});

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.get('/webhooks', { preHandler: requireScope('webhooks') }, async (req) => {
    return { webhooks: await listWebhooks(req.auth!.customer_id) };
  });

  app.post('/webhooks', { preHandler: requireScope('webhooks') }, async (req, reply) => {
    const parsed = CreateWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    }
    try {
      const row = await createWebhook({ customerId: req.auth!.customer_id, url: parsed.data.url, events: parsed.data.events });
      return reply.code(201).send(row);
    } catch (err) {
      if (err instanceof WebhookError) return reply.code(400).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.delete('/webhooks/:id', { preHandler: requireScope('webhooks') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await deleteWebhook(req.auth!.customer_id, id);
    return reply.code(204).send();
  });

  app.post('/webhooks/:id/rotate-secret', { preHandler: requireScope('webhooks') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await rotateWebhookSecret(req.auth!.customer_id, id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return reply.code(201).send({
      ...row,
      note: `Your endpoint's signature verifier should accept both "secret" and "previous_secret" until previous_secret_expires_at (${row.previous_secret_expires_at ? new Date(row.previous_secret_expires_at).toISOString() : 'n/a'}), then drop the old one.`,
    });
  });

  const DeliveriesQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    before: z.coerce.number().int().optional(),
  });
  app.get('/webhooks/:id/deliveries', { preHandler: requireScope('webhooks') }, async (req, reply) => {
    const { id } = req.params as { id: string };

    // Verify the webhook belongs to this customer. `webhooks` is RLS-protected,
    // `webhook_delivery_log` is not — each query below uses the right handle.
    const wh = await tenantScoped(req, (trx) =>
      trx.selectFrom('webhooks').select('id').where('id', '=', id).where('customer_id', '=', req.auth!.customer_id).executeTakeFirst()
    );
    if (!wh) return reply.code(404).send({ error: 'not_found' });

    const parsed = DeliveriesQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const { limit = 50, before } = parsed.data;

    let q = db
      .selectFrom('webhook_delivery_log')
      .select(['id', 'event_id', 'event_type', 'attempt', 'status_code', 'outcome', 'duration_ms', 'error', 'delivered_at'])
      .where('webhook_id', '=', id)
      .orderBy('id', 'desc')
      .limit(limit);
    if (before !== undefined) q = q.where('id', '<', before);

    const rows = await q.execute();
    const next_cursor = rows.length === limit ? rows[rows.length - 1]?.id : undefined;
    return { deliveries: rows, next_cursor };
  });

  // Send a test ping event to verify the webhook endpoint is reachable.
  app.post(
    '/webhooks/:id/test',
    {
      preHandler: requireScope('webhooks'),
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const wh = await tenantScoped(req, (trx) =>
        trx
          .selectFrom('webhooks')
          .select(['id', 'enabled'])
          .where('id', '=', id)
          .where('customer_id', '=', req.auth!.customer_id)
          .executeTakeFirst()
      );
      if (!wh) return reply.code(404).send({ error: 'not_found' });
      if (!wh.enabled) return reply.code(422).send({ error: 'webhook_disabled', message: 'Enable the webhook before sending a test ping.' });

      await webhooksQueue.add('deliver', {
        webhook_id: id,
        event_id: `test_${Date.now()}`,
        event_type: 'test_ping',
        payload: { type: 'test_ping', timestamp: new Date().toISOString() },
      });
      return reply.code(202).send({ queued: true });
    }
  );

  // Bulk-retry failed webhook deliveries for a webhook endpoint.
  const RetryFailuresSchema = z.object({
    since: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  });
  app.post(
    '/webhooks/:id/retry-failures',
    {
      preHandler: requireScope('webhooks'),
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const wh = await tenantScoped(req, (trx) =>
        trx
          .selectFrom('webhooks')
          .select(['id'])
          .where('id', '=', id)
          .where('customer_id', '=', req.auth!.customer_id)
          .executeTakeFirst()
      );
      if (!wh) return reply.code(404).send({ error: 'not_found' });

      const parsed = RetryFailuresSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
      const { since, limit = 100 } = parsed.data;

      // webhook_delivery_log is not RLS-protected — stays on global db.
      let q = db
        .selectFrom('webhook_delivery_log')
        .select(['id', 'event_id', 'event_type'])
        .where('webhook_id', '=', id)
        .where('outcome', '!=', 'success')
        .orderBy('id', 'desc')
        .limit(limit);
      if (since) q = q.where(sql<boolean>`delivered_at >= ${new Date(since)}::timestamptz`);
      const rows = await q.execute();

      // Reconstruct the ORIGINAL event payload for each row instead of
      // re-delivering an empty body. webhook_delivery_log only stores delivery
      // metadata (status/outcome/timing), not the payload itself, so we join
      // back to the source `events` row and rebuild the exact shape the event
      // worker originally sent — otherwise a "retry" silently delivers `{}`
      // to the customer's endpoint, which is worse than not retrying at all.
      // `events` IS RLS-protected, so this lookup is tenant-scoped.
      const eventIds = rows.map((r) => r.event_id).filter((v): v is number => v != null);
      const eventRows = eventIds.length
        ? await tenantScoped(req, (trx) =>
            trx
              .selectFrom('events')
              .select(['id', 'message_id', 'event_type', 'payload', 'occurred_at'])
              .where('id', 'in', eventIds)
              .execute()
          )
        : [];
      const eventById = new Map(eventRows.map((e) => [e.id, e]));

      let requeued = 0;
      let skippedNoEvent = 0;
      for (const row of rows) {
        const src = row.event_id != null ? eventById.get(row.event_id) : undefined;
        if (!src) {
          // The source event no longer exists (retention purge, deleted
          // recipient, etc.) — skip rather than deliver a fabricated payload.
          skippedNoEvent++;
          continue;
        }
        await webhooksQueue.add('deliver', buildDeliveryJob(id, src));
        requeued++;
      }

      return { retried: requeued, skipped_missing_event: skippedNoEvent };
    }
  );

  // Replay ONE specific delivery by its log id, regardless of its original
  // outcome. Useful when a customer's downstream lost an event that WE
  // delivered successfully (retry-failures only covers non-success rows).
  app.post(
    '/webhooks/:id/deliveries/:deliveryId/replay',
    {
      preHandler: requireScope('webhooks'),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { id, deliveryId } = req.params as { id: string; deliveryId: string };
      const deliveryIdNum = Number(deliveryId);
      if (!Number.isInteger(deliveryIdNum) || deliveryIdNum <= 0) {
        return reply.code(400).send({ error: 'invalid_delivery_id' });
      }

      const wh = await tenantScoped(req, (trx) =>
        trx
          .selectFrom('webhooks')
          .select(['id'])
          .where('id', '=', id)
          .where('customer_id', '=', req.auth!.customer_id)
          .executeTakeFirst()
      );
      if (!wh) return reply.code(404).send({ error: 'not_found' });

      // The delivery row must belong to THIS webhook (which we've just proven
      // belongs to this customer) — so a customer can't replay another
      // tenant's delivery by guessing a log id.
      const delivery = await db
        .selectFrom('webhook_delivery_log')
        .select(['id', 'event_id'])
        .where('id', '=', deliveryIdNum)
        .where('webhook_id', '=', id)
        .executeTakeFirst();
      if (!delivery) return reply.code(404).send({ error: 'delivery_not_found' });
      if (delivery.event_id == null) {
        return reply.code(422).send({ error: 'no_source_event', message: 'This delivery has no linked source event to replay.' });
      }

      const src = await tenantScoped(req, (trx) =>
        trx
          .selectFrom('events')
          .select(['id', 'message_id', 'event_type', 'payload', 'occurred_at'])
          .where('id', '=', delivery.event_id!)
          .executeTakeFirst()
      );
      if (!src) {
        return reply.code(422).send({ error: 'source_event_gone', message: 'The source event no longer exists (purged or erased); cannot reconstruct the payload.' });
      }

      await webhooksQueue.add('deliver', buildDeliveryJob(id, src));
      return reply.code(202).send({ replayed: deliveryIdNum, event_id: src.id });
    }
  );
};

// Rebuild the delivery job payload from a source `events` row, matching the
// exact shape the event worker originally sent. Shared by retry-failures and
// single-delivery replay so the reconstruction logic lives in one place.
function buildDeliveryJob(
  webhookId: string,
  src: { id: number; message_id: string | null; event_type: string; payload: unknown; occurred_at: unknown }
) {
  return {
    webhook_id: webhookId,
    event_id: src.id,
    event_type: src.event_type,
    payload: {
      message_id: src.message_id,
      event_type: src.event_type,
      occurred_at: new Date(src.occurred_at as string | number | Date).toISOString(),
      ...(typeof src.payload === 'object' && src.payload ? src.payload : {}),
    },
  };
}
