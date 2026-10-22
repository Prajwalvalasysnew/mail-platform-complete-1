import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import {
  db,
  listMessageActivity,
  normalizeMessageActivityQuery,
  releaseQuota,
  resolveTenantRetention,
  retentionVisibilityCutoff,
} from '@platform/shared';
import { requireScope } from '../plugins/scope.js';
import { tenantScoped } from '../lib/tenant.js';

export const messageRoutes: FastifyPluginAsync = async (app) => {
  // List messages with cursor pagination and extended filters.
  //
  // Cursor: opaque token = base64(JSON({ts, id})) representing the last row
  // seen. The compound (queued_at DESC, message_id DESC) order is stable
  // because message_id is unique and time-monotonic within a second.
  app.get('/messages', { preHandler: requireScope('messages') }, async (req) => {
    const auth = req.auth!;
    const {
      limit = '50',
      cursor,
      status,
      tag,
      to,
      from_address,
      subject_contains,
      since,
      until,
    } = req.query as Record<string, string | undefined>;

    const safeLimit = (() => {
      const n = parseInt(String(limit), 10);
      if (!Number.isFinite(n) || n <= 0) return 50;
      return Math.min(n, 500);
    })();

    // Decode cursor: {ts: ISO-string, id: string}
    let cursorTs: Date | null = null;
    let cursorId: string | null = null;
    if (cursor) {
      try {
        const { ts, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        cursorTs = new Date(ts);
        cursorId = id;
      } catch {
        // Malformed cursor — start from the beginning.
      }
    }

    // Plan-tiered history window (Phase 2.1): tenants with an explicit
    // retention plan/override see only that window; others keep the full
    // physically-retained history.
    const visibilityCutoff = await retentionVisibilityCutoff(auth.customer_id);

    const rows = await tenantScoped(req, (trx) => {
      let q = trx
        .selectFrom('messages')
        .select([
          'message_id', 'from_address', 'to_address', 'subject',
          'status', 'tags', 'queued_at', 'accepted_at', 'delivered_at',
          'bounced_at', 'opened_at', 'first_clicked_at', 'attempts',
          'human_opened_at', 'human_clicked_at',
          'message_class', 'template_id',
        ])
        .where('customer_id', '=', auth.customer_id);

      if (visibilityCutoff) {
        q = q.where('queued_at', '>=', visibilityCutoff as any);
      }

      if (status) q = q.where('status', '=', status as any);
      if (to) q = q.where('to_address', '=', to);
      if (from_address) q = q.where('from_address', '=', from_address);
      if (tag) q = q.where(({ eb, val }) => eb(sql`tags`, '&&', sql`ARRAY[${val(tag)}]::text[]`));
      if (since) q = q.where(sql<boolean>`queued_at >= ${since}::timestamptz`);
      if (until) q = q.where(sql<boolean>`queued_at <= ${until}::timestamptz`);
      if (subject_contains) {
        q = q.where(sql<boolean>`LOWER(subject) LIKE '%' || LOWER(${subject_contains}) || '%'`);
      }

      // Cursor: (queued_at, message_id) < (cursor_ts, cursor_id) for DESC order.
      if (cursorTs && cursorId) {
        q = q.where(sql<boolean>`(queued_at, message_id) < (${cursorTs.toISOString()}::timestamptz, ${cursorId})`);
      }

      return q
        .orderBy('queued_at', 'desc')
        .orderBy('message_id', 'desc')
        .limit(safeLimit)
        .execute();
    });

    const next_cursor = rows.length === safeLimit
      ? Buffer.from(
          JSON.stringify({ ts: rows[rows.length - 1]!.queued_at, id: rows[rows.length - 1]!.message_id })
        ).toString('base64url')
      : undefined;

    return { messages: rows, next_cursor };
  });

  // Searchable delivery/activity feed for message events. This is the customer
  // log surface behind dashboard/support views: newest-first, org-scoped, and
  // cursor-paginated so large event streams don't rely on deep offsets.
  app.get('/messages/activity', { preHandler: requireScope('messages') }, async (req) => {
    const auth = req.auth!;
    const query = normalizeMessageActivityQuery(req.query as Record<string, string>);
    // Clamp the lookback to the tenant's plan window when one is configured.
    const windows = await resolveTenantRetention(auth.customer_id);
    if (windows.explicit) {
      query.sinceDays = Math.min(query.sinceDays, windows.eventsDays);
    }
    return tenantScoped(req, (trx) => listMessageActivity(auth.customer_id, query, trx));
  });

  // List scheduled messages (send_at in the future, not yet dispatched).
  // Ordered by send_at ASC — soonest first. Separate from /messages so
  // callers get a clean scheduled-only view without manual filtering.
  app.get('/messages/scheduled', { preHandler: requireScope('messages') }, async (req) => {
    const auth = req.auth!;
    const { limit = '50', cursor } = req.query as Record<string, string | undefined>;
    const safeLimit = Math.min(Math.max(1, parseInt(String(limit), 10) || 50), 500);

    let cursorSendAt: Date | null = null;
    let cursorId: string | null = null;
    if (cursor) {
      try {
        const { send_at, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        cursorSendAt = new Date(send_at);
        cursorId = id;
      } catch {
        // Malformed cursor — start from beginning.
      }
    }

    const rows = await tenantScoped(req, (trx) => {
      let q = trx
        .selectFrom('messages')
        .select(['message_id', 'from_address', 'to_address', 'subject', 'tags', 'queued_at', 'send_at', 'status'])
        .where('customer_id', '=', auth.customer_id)
        .where('status', '=', 'queued')
        .where(sql<boolean>`send_at > now()`);

      if (cursorSendAt && cursorId) {
        q = q.where(sql<boolean>`(send_at, message_id) > (${cursorSendAt.toISOString()}::timestamptz, ${cursorId})`);
      }

      return q.orderBy('send_at', 'asc').orderBy('message_id', 'asc').limit(safeLimit + 1).execute();
    });

    const hasMore = rows.length > safeLimit;
    const items = hasMore ? rows.slice(0, safeLimit) : rows;
    const last = items[items.length - 1];
    const next_cursor = hasMore && last
      ? Buffer.from(JSON.stringify({ send_at: last.send_at, id: last.message_id })).toString('base64url')
      : undefined;
    return { messages: items, next_cursor };
  });

  // Cancel a scheduled message before it is dispatched.
  // Cancellation succeeds only when the outbox entry is still 'pending'
  // (not yet picked up by the worker). Returns 409 once dispatched.
  app.delete('/messages/:messageId/cancel', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const { messageId } = req.params as { messageId: string };

    const msg = await tenantScoped(req, (trx) =>
      trx
        .selectFrom('messages')
        .select(['message_id', 'status', 'send_at'])
        .where('message_id', '=', messageId)
        .where('customer_id', '=', auth.customer_id)
        .executeTakeFirst()
    );

    if (!msg) return reply.code(404).send({ error: 'not_found' });

    // Only messages that are still waiting to be dispatched can be cancelled.
    if (msg.status !== 'queued' || !msg.send_at || new Date(msg.send_at) <= new Date()) {
      return reply.code(409).send({
        error: 'not_cancellable',
        message: `Message status is '${msg.status}'; only pending scheduled messages can be cancelled.`,
      });
    }

    // send_outbox is not an RLS-protected table, so this stays on the global
    // db (matches send.ts's worker-facing outbox handling elsewhere).
    // Cancel the outbox entry — if the worker already grabbed it, this is a no-op
    // and the message will send. The status remains 'queued' in that edge case;
    // callers can detect this by checking the status in the response.
    const outboxResult = await db
      .updateTable('send_outbox')
      .set({ status: 'failed', last_error: 'cancelled_by_user', updated_at: new Date() })
      .where('message_id', '=', messageId)
      .where('customer_id', '=', auth.customer_id)
      .where('status', '=', 'pending')
      .executeTakeFirst();

    if (Number(outboxResult.numUpdatedRows ?? 0) === 0) {
      return reply.code(409).send({ error: 'already_dispatched', message: 'The message was already picked up for delivery and cannot be cancelled.' });
    }

    await tenantScoped(req, (trx) =>
      trx
        .updateTable('messages')
        .set({ status: 'failed', failure_reason: 'cancelled_by_user' })
        .where('message_id', '=', messageId)
        .where('customer_id', '=', auth.customer_id)
        .execute()
    );

    // /send reserves one quota unit per recipient before creating each
    // scheduled message. Once cancellation wins the outbox race, that unit
    // can no longer result in a delivery and must be returned to the tenant.
    await releaseQuota(auth.customer_id, 1);

    return reply.code(200).send({ cancelled: messageId });
  });

  // Get one message with full event timeline
  app.get('/messages/:messageId', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const { messageId } = req.params as { messageId: string };

    const visibilityCutoff = await retentionVisibilityCutoff(auth.customer_id);
    const result = await tenantScoped(req, async (trx) => {
      let msgQuery = trx
        .selectFrom('messages')
        .selectAll()
        .where('message_id', '=', messageId)
        .where('customer_id', '=', auth.customer_id);
      if (visibilityCutoff) {
        msgQuery = msgQuery.where('queued_at', '>=', visibilityCutoff as any);
      }
      const msg = await msgQuery.executeTakeFirst();
      if (!msg) return null;

      const events = await trx
        .selectFrom('events')
        .select(['event_type', 'payload', 'ip', 'user_agent', 'bot_verdict', 'bot_score', 'occurred_at'])
        .where('message_id', '=', messageId)
        .orderBy('occurred_at', 'asc')
        .execute();

      return { msg, events };
    });

    if (!result) return reply.code(404).send({ error: 'not_found' });

    // Expose hold_reason without leaking the numeric risk score.
    const hold_reason = result.msg.status === 'held' ? 'under_review' : undefined;

    // Attachment metadata is part of the message record; the raw content
    // (inline storage keeps content_b64 in the row) is not an API payload.
    const message = {
      ...result.msg,
      attachments: result.msg.attachments
        ? result.msg.attachments.map(({ filename, content_type, size }) => ({ filename, content_type, size }))
        : null,
    };

    return { message, events: result.events, ...(hold_reason ? { hold_reason } : {}) };
  });
};
