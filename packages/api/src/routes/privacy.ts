import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { removeSuppression, getBodyStore, clickhouseEnabled, purgeQueuedMessageData, assertNoActiveHold, LegalHoldError, placeLegalHold, releaseLegalHold, listLegalHolds, recipientHoldScope } from '@platform/shared';
import { requireScope } from '../plugins/scope.js';
import { tenantScoped } from '../lib/tenant.js';

const DeleteSchema = z.object({
  recipient: z.string().email(),
  requested_by: z.string().max(200).optional(),
});

const PlaceHoldSchema = z.object({
  // 'customer' for a tenant-wide hold, or an email / 'recipient:<email>' for one recipient.
  scope: z.string().min(1).max(320),
  reason: z.string().min(1).max(1000),
});

/**
 * GDPR / CCPA data-subject deletion. Removes all messages, events, suppression
 * entries, and soft-bounce tracking for a given recipient under the calling
 * customer, and records an auditable deletion request. Scoped to the customer's
 * own data — a customer can only erase recipients in their own tenant.
 */
export const privacyRoutes: FastifyPluginAsync = async (app) => {
  app.post('/privacy/delete-recipient', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = DeleteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    }
    const recipient = parsed.data.recipient.toLowerCase();

    // tenantScoped() opens the transaction with app.customer_id set for RLS,
    // which also serves as the erasure transaction itself.
    let result;
    try {
      result = await tenantScoped(req, async (trx) => {
      // Legal hold gate (gap analysis #19): if an active hold covers this
      // recipient (a tenant-wide 'customer' hold or a 'recipient:<email>' hold),
      // erasure is BLOCKED. Checked first, inside the transaction, before any
      // row is touched — so held data is never destroyed. Throws LegalHoldError,
      // translated to a 409 below.
      await assertNoActiveHold(auth.customer_id, recipient, trx);

      // Create subquery to select message_ids for the recipient
      const subquery = trx
        .selectFrom('messages')
        .select('message_id')
        .where('customer_id', '=', auth.customer_id)
        .where('to_address', '=', recipient);

      // Capture the offloaded body object keys for this recipient's messages
      // BEFORE we delete the rows. GDPR erasure must remove the body content
      // (which holds the recipient's PII) from object storage too — deleting only
      // the DB row would orphan the PII-bearing object in fs/s3 indefinitely.
      const keyRows = await trx
        .selectFrom('messages')
        .select('body_object_key')
        .where('customer_id', '=', auth.customer_id)
        .where('to_address', '=', recipient)
        .where('body_storage', '!=', 'inline')
        .where('body_object_key', 'is not', null)
        .execute();
      const candidateKeys = Array.from(new Set(keyRows.map((r) => r.body_object_key as string)));
      const messageRows = await trx.selectFrom('messages').select('message_id')
        .where('customer_id', '=', auth.customer_id).where('to_address', '=', recipient).execute();
      const messageIds = messageRows.map((row) => row.message_id);

      // Event rows and tracked links are keyed by message_id; delete them using the subquery
      const ev = await trx
        .deleteFrom('events')
        .where('customer_id', '=', auth.customer_id)
        .where('message_id', 'in', subquery)
        .executeTakeFirst();
      const eventsDeleted = Number(ev.numDeletedRows ?? 0);

      await trx
        .deleteFrom('tracked_links')
        .where('message_id', 'in', subquery)
        .execute();

      const msgDel = await trx
        .deleteFrom('messages')
        .where('customer_id', '=', auth.customer_id)
        .where('to_address', '=', recipient)
        .executeTakeFirst();

      await trx
        .deleteFrom('soft_bounce_tracker')
        .where('customer_id', '=', auth.customer_id)
        .where('email', '=', recipient)
        .execute();

      // Of the candidate keys, find which are STILL referenced by a surviving
      // message (bodies are content-addressed and deduped across recipients, so
      // a shared body must not be deleted while another message needs it).
      let orphanKeys: string[] = [];
      if (candidateKeys.length > 0) {
        const stillReferenced = await trx
          .selectFrom('messages')
          .select('body_object_key')
          .where('body_object_key', 'in', candidateKeys)
          .execute();
        const liveKeys = new Set(stillReferenced.map((r) => r.body_object_key as string));
        orphanKeys = candidateKeys.filter((k) => !liveKeys.has(k));
      }

      const log = await trx
        .insertInto('deletion_requests')
        .values({
          customer_id: auth.customer_id,
          recipient,
          requested_by: parsed.data.requested_by ?? null,
          messages_deleted: Number(msgDel.numDeletedRows ?? 0),
          events_deleted: eventsDeleted,
          status: 'pending',
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      if (orphanKeys.length > 0) {
        const storageKind = getBodyStore().kind;
        await trx.insertInto('deletion_object_items').values(
          orphanKeys.map((objectKey) => ({
            deletion_request_id: log.id,
            object_key: objectKey,
            storage_kind: storageKind,
          }))
        ).execute();
      }
      if (clickhouseEnabled() && messageIds.length > 0) {
        await trx.insertInto('deletion_object_items').values(messageIds.map((messageId) => ({
          deletion_request_id: log.id,
          object_key: messageId,
          storage_kind: 'clickhouse',
        }))).execute();
      }
      if (messageIds.length > 0) {
        await trx.insertInto('privacy_message_tombstones').values(messageIds.map((messageId) => ({
          customer_id: auth.customer_id,
          message_id: messageId,
          deletion_request_id: log.id,
        }))).onConflict((oc) => oc.columns(['customer_id', 'message_id']).doNothing()).execute();
        await trx.insertInto('deletion_object_items').values(messageIds.map((messageId) => ({
          deletion_request_id: log.id,
          object_key: messageId,
          storage_kind: 'bullmq',
        }))).execute();
      }

      // Suppression removal happens INSIDE the tenant transaction too now (it
      // touches the RLS-protected `suppressions` table), but the Redis cache
      // clear it performs is a separate side effect that is safe either way.
      await removeSuppression(auth.customer_id, recipient, trx, { source: 'gdpr_erasure', reason: 'erasure' });

      return {
        request_id: log.id,
        messages_deleted: Number(msgDel.numDeletedRows ?? 0),
        events_deleted: eventsDeleted,
        orphanKeys,
        messageIds,
      };
    });
    } catch (err) {
      // A recipient under an active legal hold cannot be erased. Return 409
      // Conflict with the blocking hold reasons, so the caller understands why.
      if (err instanceof LegalHoldError) {
        return reply.code(409).send({
          error: 'legal_hold_active',
          message: 'Erasure is blocked: the recipient is under an active legal hold.',
          holds: err.holds.map((h) => ({ id: h.id, scope: h.scope, reason: h.reason })),
        });
      }
      throw err;
    }

    // Delete orphaned body objects from the store AFTER the DB commit (so we
    // never delete an object that a rolled-back transaction would have kept).
    // Best-effort per key; a store failure is logged but does not fail the
    // erasure (the DB rows — the authoritative record — are already gone).
    const bodyStore = getBodyStore();
    let bodiesDeleted = 0;
    const failedObjects: Array<{ key: string; error: string }> = [];
    if (bodyStore.kind !== 'inline' && result.orphanKeys.length > 0) {
      for (const key of result.orphanKeys) {
        try {
          await bodyStore.delete(key);
          bodiesDeleted++;
          await tenantScoped(req, (trx) => trx.updateTable('deletion_object_items').set({
            status: 'completed', attempts: 1, completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_error: null,
          }).where('deletion_request_id', '=', result.request_id).where('object_key', '=', key).execute());
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failedObjects.push({ key, error: message });
          await tenantScoped(req, (trx) => trx.updateTable('deletion_object_items').set({
            status: 'failed', attempts: 1, last_error: message.slice(0, 2000), updated_at: new Date().toISOString(),
          }).where('deletion_request_id', '=', result.request_id).where('object_key', '=', key).execute());
          req.log.warn({ err, key }, 'GDPR erasure: failed to delete body object');
        }
      }
    }

    for (const messageId of result.messageIds) {
      try {
        const queueResult = await purgeQueuedMessageData(messageId);
        if (queueResult.active > 0) throw new Error(`bullmq_active_jobs:${queueResult.active}`);
        await tenantScoped(req, (trx) => trx.updateTable('deletion_object_items').set({
          status: 'completed', attempts: 1, completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_error: null,
        }).where('deletion_request_id', '=', result.request_id).where('storage_kind', '=', 'bullmq').where('object_key', '=', messageId).execute());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await tenantScoped(req, (trx) => trx.updateTable('deletion_object_items').set({
          status: 'failed', attempts: 1, last_error: message.slice(0, 2000), updated_at: new Date().toISOString(),
        }).where('deletion_request_id', '=', result.request_id).where('storage_kind', '=', 'bullmq').where('object_key', '=', messageId).execute());
        req.log.warn({ err, messageId }, 'GDPR erasure: failed to purge BullMQ payloads');
      }
    }

    const outstanding = await tenantScoped(req, (trx) => trx.selectFrom('deletion_object_items')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('deletion_request_id', '=', result.request_id)
      .where('status', '!=', 'completed').executeTakeFirstOrThrow());
    const finalStatus = Number(outstanding.count) === 0 ? 'completed' : 'pending';
    await tenantScoped(req, (trx) => trx.updateTable('deletion_requests')
      .set({ status: finalStatus })
      .where('id', '=', result.request_id)
      .where('customer_id', '=', auth.customer_id)
      .execute());

    return reply.code(finalStatus === 'completed' ? 200 : 202).send({
      recipient,
      status: finalStatus,
      request_id: result.request_id,
      messages_deleted: result.messages_deleted,
      events_deleted: result.events_deleted,
      bodies_deleted: bodiesDeleted,
      objects_pending: Number(outstanding.count),
    });
  });

  // List prior deletion requests (proof of compliance).
  app.get('/privacy/deletions', { preHandler: requireScope('messages') }, async (req) => {
    const auth = req.auth!;
    const rows = await tenantScoped(req, (trx) =>
      trx
        .selectFrom('deletion_requests')
        .select(['id', 'recipient', 'messages_deleted', 'events_deleted', 'status', 'created_at'])
        .where('customer_id', '=', auth.customer_id)
        .orderBy('created_at', 'desc')
        .limit(200)
        .execute()
    );
    return { deletions: rows };
  });

  // GDPR Article 15 right-to-access: export all data held for a recipient.
  const ExportQuery = z.object({ email: z.string().email() });
  app.get('/privacy/export-recipient', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = ExportQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const recipient = parsed.data.email.toLowerCase();

    const { messages, events, suppression } = await tenantScoped(req, async (trx) => {
      const messages = await trx
        .selectFrom('messages')
        .select(['message_id', 'subject', 'status', 'queued_at', 'delivered_at', 'bounced_at', 'opened_at', 'first_clicked_at'])
        .where('customer_id', '=', auth.customer_id)
        .where('to_address', '=', recipient)
        .orderBy('queued_at', 'desc')
        .limit(1000)
        .execute();

      const messageIds = messages.map((m) => m.message_id);
      const events = messageIds.length > 0
        ? await trx
            .selectFrom('events')
            .select(['id', 'message_id', 'event_type', 'occurred_at', 'ip', 'payload'])
            .where('customer_id', '=', auth.customer_id)
            .where('message_id', 'in', messageIds)
            .orderBy('occurred_at', 'desc')
            .limit(5000)
            .execute()
        : [];

      const suppression = await trx
        .selectFrom('suppressions')
        .select(['reason', 'created_at'])
        .where('customer_id', '=', auth.customer_id)
        .where('email', '=', recipient)
        .executeTakeFirst();

      return { messages, events, suppression };
    });

    return {
      recipient,
      exported_at: new Date().toISOString(),
      messages,
      events,
      suppressed: suppression ? { reason: suppression.reason, since: suppression.created_at } : null,
    };
  });

  // ─── Legal holds (gap analysis #19) ────────────────────────────────────────
  // Place / list / release legal holds. A hold blocks erasure for its scope.
  // Requires the messages scope (same as erasure); a customer can only manage
  // holds on their own tenant.
  app.get('/privacy/legal-holds', { preHandler: requireScope('messages') }, async (req) => {
    const auth = req.auth!;
    const { active } = req.query as { active?: string };
    const holds = await tenantScoped(req, (trx) =>
      listLegalHolds(auth.customer_id, { activeOnly: active === 'true' }, trx)
    );
    return { holds };
  });

  app.post('/privacy/legal-holds', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = PlaceHoldSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    // Normalize scope: a bare email becomes recipient:<email>; 'customer' stays.
    const scope = parsed.data.scope === 'customer'
      ? 'customer'
      : recipientHoldScope(parsed.data.scope.replace(/^recipient:/i, ''));
    const hold = await tenantScoped(req, (trx) =>
      placeLegalHold({ customerId: auth.customer_id, scope, reason: parsed.data.reason, createdBy: auth.api_key_id ?? 'api' }, trx)
    );
    return reply.code(201).send({ hold });
  });

  app.post('/privacy/legal-holds/:id/release', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const ok = await tenantScoped(req, (trx) => releaseLegalHold(auth.customer_id, id, auth.api_key_id ?? 'api', trx));
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    return { released: id };
  });
};
