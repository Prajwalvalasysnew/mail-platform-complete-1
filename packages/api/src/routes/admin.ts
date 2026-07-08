import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { sql } from 'kysely';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { stripeSubscriptionEvent, paypalSubscriptionEvent, cashfreeSubscriptionEvent } from './billing.js';
import {
  db,
  sendQueue,
  createSendOutboxRows,
  drainSendOutbox,
  eventsQueue,
  resolveAdminSession,
  verifyAdminPasswordCredentials,
  createAdminSession,
  createAdminSessionForPasswordAuth,
  beginAdminTotpEnrollment,
  confirmAdminTotpEnrollment,
  verifyAdminTotp,
  disableAdminTotp,
  revokeAdminSession,
  listAdminUsers,
  createAdminUser,
  updateAdminUser,
  setAdminPassword,
  auditAdminAction,
  listBillingEvents,
  getBillingEvent,
  replayBillingEvent,
  applySubscriptionState,
  roleAtLeast,
  evaluatePoolHealth,
  monitorAllBlocklists,
  generateApiKeyV2,
  normalizeSupportCustomerQuery,
  listSupportCustomers,
  getSupportCustomerOverview,
  createSupportNote,
  listSupportNotes,
  normalizeSupportTicketQuery,
  listSupportTickets,
  createSupportTicket,
  getSupportTicket,
  appendSupportTicketMessage,
  countUnreadSupportTickets,
  updateSupportTicket,
  triageSupportTicket,
  suggestSupportReply,
  listSlaBreaches,
  listCannedResponses,
  createCannedResponse,
  updateCannedResponse,
  deleteCannedResponse,
  markSupportTicketRead,
  listDeadLetter,
  getDeadLetter,
  replayDeadLetter,
  purgeDeadLetter,
  purgeAllDeadLetters,
  runRetention,
  reconcileMetering,
  type AdminContext,
  type AdminRole,
} from '@platform/shared';

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminContext;
  }
}

function requireAdmin(minRole: AdminRole) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'admin_auth_required' });
    }
    const ctx = await resolveAdminSession(header.slice(7).trim());
    if (!ctx) return reply.code(401).send({ error: 'invalid_admin_session' });
    if (!roleAtLeast(ctx.role, minRole)) {
      return reply.code(403).send({ error: 'insufficient_role', message: `Requires role >= ${minRole}` });
    }
    req.admin = ctx;
  };
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  // ---- Customer support console ----
  app.get('/customers', { preHandler: requireAdmin('support') }, async (req) => {
    const query = normalizeSupportCustomerQuery(req.query as Record<string, string>);
    return listSupportCustomers(query);
  });

  app.get('/customers/:id', { preHandler: requireAdmin('support') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const overview = await getSupportCustomerOverview(id);
    if (!overview) return reply.code(404).send({ error: 'not_found' });
    await auditAdminAction(req.admin!, 'customer_view', 'customer', {}, id);
    return overview;
  });

  app.get('/customers/:id/support-notes', { preHandler: requireAdmin('support') }, async (req) => {
    const { id } = req.params as { id: string };
    const { limit = '50' } = req.query as Record<string, string>;
    return { notes: await listSupportNotes(id, parseInt(limit, 10)) };
  });

  const NoteSchema = z.object({
    body: z.string().trim().min(1).max(5000),
    visibility: z.enum(['internal', 'escalation']).optional(),
  });
  app.post('/customers/:id/support-notes', { preHandler: requireAdmin('support') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = NoteSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });

    const customer = await db.selectFrom('customers').select('id').where('id', '=', id).executeTakeFirst();
    if (!customer) return reply.code(404).send({ error: 'not_found' });

    const note = await createSupportNote({
      customerId: id,
      adminUserId: req.admin!.admin_user_id,
      body: parsed.data.body,
      visibility: parsed.data.visibility,
    });
    await auditAdminAction(req.admin!, 'support_note_create', 'support_note', { note_id: note.id, visibility: note.visibility }, id);
    return reply.code(201).send({ note });
  });

  // ---- Support tickets / conversations ----
  const TicketCreateSchema = z.object({
    customer_id: z.string().uuid(),
    subject: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(10000),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    category: z.enum(['general', 'billing', 'deliverability', 'technical', 'abuse', 'account']).optional(),
    assign_to_me: z.boolean().optional(),
  });

  app.get('/support-tickets', { preHandler: requireAdmin('support') }, async (req) => {
    const query = normalizeSupportTicketQuery(req.query as Record<string, string>);
    return listSupportTickets(query, req.admin!.admin_user_id);
  });

  app.get('/support-tickets/unread-count', { preHandler: requireAdmin('support') }, async (req) => {
    return {
      unread: await countUnreadSupportTickets({
        viewerType: 'admin',
        viewerAdminUserId: req.admin!.admin_user_id,
      }),
    };
  });

  app.post('/support-tickets', { preHandler: requireAdmin('support') }, async (req, reply) => {
    const parsed = TicketCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });

    const customer = await db.selectFrom('customers').select('id').where('id', '=', parsed.data.customer_id).executeTakeFirst();
    if (!customer) return reply.code(404).send({ error: 'not_found' });

    const ticket = await createSupportTicket({
      customerId: parsed.data.customer_id,
      subject: parsed.data.subject,
      body: parsed.data.body,
      priority: parsed.data.priority,
      category: parsed.data.category,
      adminUserId: parsed.data.assign_to_me ? req.admin!.admin_user_id : null,
    });
    await auditAdminAction(req.admin!, 'support_ticket_create', 'support_ticket', { ticket_id: ticket.id, priority: ticket.priority, category: ticket.category }, ticket.customer_id);
    return reply.code(201).send({ ticket });
  });

  app.get('/support-tickets/:id', { preHandler: requireAdmin('support') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = await getSupportTicket(id, { includeInternal: true });
    if (!detail) return reply.code(404).send({ error: 'not_found' });
    return detail;
  });

  app.post('/support-tickets/:id/read', { preHandler: requireAdmin('support') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await markSupportTicketRead({
      ticketId: id,
      viewerType: 'admin',
      viewerAdminUserId: req.admin!.admin_user_id,
    });
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { ok: true, last_read_at: row.last_read_at };
  });

  const TicketMessageSchema = z.object({
    body: z.string().trim().min(1).max(10000),
    internal: z.boolean().optional(),
  });

  app.post('/support-tickets/:id/messages', { preHandler: requireAdmin('support') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = TicketMessageSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });

    const msg = await appendSupportTicketMessage({
      ticketId: id,
      adminUserId: req.admin!.admin_user_id,
      body: parsed.data.body,
      internal: parsed.data.internal,
    });
    if (!msg) return reply.code(404).send({ error: 'not_found' });

    const detail = await getSupportTicket(id);
    await auditAdminAction(req.admin!, 'support_ticket_message', 'support_ticket', { ticket_id: id, message_id: msg.id, internal: msg.internal }, detail?.ticket.customer_id);
    return reply.code(201).send({ message: msg });
  });

  const TicketPatchSchema = z.object({
    status: z.enum(['open', 'pending', 'resolved', 'closed']).optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    category: z.enum(['general', 'billing', 'deliverability', 'technical', 'abuse', 'account']).optional(),
    assigned_admin_user_id: z.string().uuid().nullable().optional(),
    assign_to_me: z.boolean().optional(),
  });

  app.patch('/support-tickets/:id', { preHandler: requireAdmin('support') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = TicketPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });

    const assignedAdminUserId =
      parsed.data.assign_to_me ? req.admin!.admin_user_id :
        'assigned_admin_user_id' in parsed.data ? parsed.data.assigned_admin_user_id ?? null :
          undefined;

    if (assignedAdminUserId) {
      const assignee = await db.selectFrom('admin_users').select('id').where('id', '=', assignedAdminUserId).where('disabled', '=', false).executeTakeFirst();
      if (!assignee) return reply.code(400).send({ error: 'invalid_assignee' });
    }

    const ticket = await updateSupportTicket({
      ticketId: id,
      status: parsed.data.status,
      priority: parsed.data.priority,
      category: parsed.data.category,
      assignedAdminUserId,
    });
    if (!ticket) return reply.code(404).send({ error: 'not_found' });
    await auditAdminAction(req.admin!, 'support_ticket_update', 'support_ticket', { ticket_id: id, changes: parsed.data }, ticket.customer_id);
    return { ticket };
  });

  app.post('/support-tickets/:id/triage', { preHandler: requireAdmin('support') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await triageSupportTicket(id);
    if (!result) return reply.code(404).send({ error: 'not_found' });
    await auditAdminAction(req.admin!, 'support_ticket_triage', 'support_ticket', {
      ticket_id: id,
      model: result.triage.model,
      confidence: result.triage.confidence,
      suggested_priority: result.triage.suggested_priority,
      suggested_category: result.triage.suggested_category,
    }, result.ticket.customer_id);
    return result;
  });

  // ---- Review queue ----
  const ReviewQueueListQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().uuid().optional(),
    min_score: z.coerce.number().int().min(0).max(100).optional(),
    max_score: z.coerce.number().int().min(0).max(100).optional(),
  });
  app.get('/review-queue', { preHandler: requireAdmin('support') }, async (req, reply) => {
    const parsed = ReviewQueueListQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const { limit = 50, cursor, min_score, max_score } = parsed.data;

    let q = db
      .selectFrom('review_queue')
      .selectAll()
      .where('status', '=', 'pending')
      .orderBy('id', 'asc')
      .limit(limit + 1);
    if (cursor) q = q.where('id', '>', cursor);
    if (min_score !== undefined) q = q.where('risk_score', '>=', min_score);
    if (max_score !== undefined) q = q.where('risk_score', '<=', max_score);

    const rows = await q.execute();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, next_cursor: hasMore ? items[items.length - 1]?.id : undefined };
  });

  // Review queue aggregate stats for operator dashboards.
  app.get('/review-queue/stats', { preHandler: requireAdmin('support') }, async () => {
    const [pending, activityToday, oldest] = await Promise.all([
      db.selectFrom('review_queue').select(db.fn.countAll<number>().as('n')).where('status', '=', 'pending').executeTakeFirstOrThrow(),
      db.selectFrom('review_queue')
        .select([
          db.fn.countAll<number>().as('n'),
          'status',
        ])
        .where('reviewed_at', '>=', new Date(Date.now() - 86400_000))
        .where('status', 'in', ['approved', 'rejected'])
        .groupBy('status')
        .execute(),
      db.selectFrom('review_queue')
        .select(['created_at'])
        .where('status', '=', 'pending')
        .orderBy('created_at', 'asc')
        .limit(1)
        .executeTakeFirst(),
    ]);

    const todayByStatus: Record<string, number> = {};
    for (const r of activityToday) todayByStatus[r.status] = Number(r.n);

    const avgScore = await db
      .selectFrom('review_queue')
      .select(db.fn.avg<number>('risk_score').as('avg'))
      .where('status', '=', 'pending')
      .executeTakeFirst();

    const oldestSeconds = oldest?.created_at
      ? Math.floor((Date.now() - (oldest.created_at as unknown as Date).getTime()) / 1000)
      : 0;

    return {
      pending: Number(pending.n),
      approved_today: todayByStatus['approved'] ?? 0,
      rejected_today: todayByStatus['rejected'] ?? 0,
      avg_risk_score: avgScore?.avg ? Number(Number(avgScore.avg).toFixed(1)) : 0,
      oldest_pending_seconds: oldestSeconds,
    };
  });

  app.post('/review-queue/:id/approve', { preHandler: requireAdmin('operator'), config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const item = await db.selectFrom('review_queue').selectAll().where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
    if (!item) return reply.code(404).send({ error: 'not_found' });

    // Release the held message via the transactional send outbox. The message
    // status flip, review decision, and durable enqueue intent commit together
    // — a Redis outage or crash here can no longer strand an "approved"
    // message with no job (the scheduler drains pending outbox rows).
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('messages').set({ status: 'queued' }).where('message_id', '=', item.message_id).execute();
      await trx.updateTable('review_queue').set({ status: 'approved', reviewed_at: new Date() }).where('id', '=', id).execute();
      await createSendOutboxRows(
        [{ message_id: item.message_id, customer_id: item.customer_id, priority: 5 }],
        trx
      );
    });
    // Best-effort immediate drain; on failure the scheduler picks it up.
    try { await drainSendOutbox({ messageIds: [item.message_id] }); } catch { /* scheduler will drain */ }
    await eventsQueue.add('review_approved', { message_id: item.message_id, customer_id: item.customer_id, event_type: 'queued', payload: { reason: 'review_approved' } });
    await auditAdminAction(req.admin!, 'review_approve', item.message_id, { risk_score: item.risk_score }, item.customer_id);
    return { approved: item.message_id };
  });

  app.post('/review-queue/:id/reject', { preHandler: requireAdmin('operator'), config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const item = await db.selectFrom('review_queue').selectAll().where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
    if (!item) return reply.code(404).send({ error: 'not_found' });
    await db.updateTable('messages').set({ status: 'failed', failure_reason: 'rejected_in_review' }).where('message_id', '=', item.message_id).execute();
    await db.updateTable('review_queue').set({ status: 'rejected', reviewed_at: new Date() }).where('id', '=', id).execute();
    await eventsQueue.add('review_rejected', { message_id: item.message_id, customer_id: item.customer_id, event_type: 'failed', payload: { reason: 'rejected_in_review' } });
    await auditAdminAction(req.admin!, 'review_reject', item.message_id, {}, item.customer_id);
    return { rejected: item.message_id };
  });

  const BulkReviewSchema = z.object({
    action: z.enum(['approve', 'reject']),
    ids: z.array(z.string().uuid()).min(1).max(200),
  });
  app.post('/review-queue/bulk', { preHandler: requireAdmin('operator'), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = BulkReviewSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const { action, ids } = parsed.data;

    const items = await db
      .selectFrom('review_queue')
      .selectAll()
      .where('id', 'in', ids)
      .where('status', '=', 'pending')
      .execute();

    if (!items.length) return reply.code(404).send({ error: 'not_found', message: 'No pending items matched the provided IDs.' });

    const approved: string[] = [];
    const rejected: string[] = [];

    for (const item of items) {
      if (action === 'approve') {
        // Same crash-safe pattern as single approve: status flip + decision +
        // durable enqueue intent commit atomically via the send outbox.
        await db.transaction().execute(async (trx) => {
          await trx.updateTable('messages').set({ status: 'queued' }).where('message_id', '=', item.message_id).execute();
          await trx.updateTable('review_queue').set({ status: 'approved', reviewed_at: new Date() }).where('id', '=', item.id).execute();
          await createSendOutboxRows(
            [{ message_id: item.message_id, customer_id: item.customer_id, priority: 5 }],
            trx
          );
        });
        try { await drainSendOutbox({ messageIds: [item.message_id] }); } catch { /* scheduler will drain */ }
        await eventsQueue.add('review_approved', { message_id: item.message_id, customer_id: item.customer_id, event_type: 'queued', payload: { reason: 'review_approved' } });
        approved.push(item.message_id);
      } else {
        await db.updateTable('messages').set({ status: 'failed', failure_reason: 'rejected_in_review' }).where('message_id', '=', item.message_id).execute();
        await db.updateTable('review_queue').set({ status: 'rejected', reviewed_at: new Date() }).where('id', '=', item.id).execute();
        await eventsQueue.add('review_rejected', { message_id: item.message_id, customer_id: item.customer_id, event_type: 'failed', payload: { reason: 'rejected_in_review' } });
        rejected.push(item.message_id);
      }
    }

    await auditAdminAction(req.admin!, `review_bulk_${action}`, 'review_queue', { ids, approved, rejected, count: items.length });
    return { action, approved, rejected, processed: items.length, not_found: ids.length - items.length };
  });

  // ---- Dead-letter queue inspection / recovery ----
  const DlqListQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  });
  app.get('/dlq', { preHandler: requireAdmin('operator') }, async (req, reply) => {
    const parsed = DlqListQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    return listDeadLetter(parsed.data);
  });

  const DlqIdParams = z.object({ id: z.string().min(1).max(200) });
  app.get('/dlq/:id', { preHandler: requireAdmin('operator') }, async (req, reply) => {
    const parsed = DlqIdParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const job = await getDeadLetter(parsed.data.id);
    if (!job) return reply.code(404).send({ error: 'not_found' });
    return { job };
  });

  app.post('/dlq/:id/replay', { preHandler: requireAdmin('operator'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = DlqIdParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    try {
      const result = await replayDeadLetter(parsed.data.id);
      if (!result) return reply.code(404).send({ error: 'not_found' });
      await auditAdminAction(req.admin!, 'dlq_replay', 'dead_letter', { id: parsed.data.id, source_queue: result.source_queue, new_job_id: result.new_job_id });
      return reply.code(202).send(result);
    } catch (err: any) {
      if (String(err?.message ?? err).startsWith('unsupported_source_queue:')) {
        return reply.code(400).send({ error: 'unsupported_source_queue', message: err.message });
      }
      throw err;
    }
  });

  app.delete('/dlq/:id', { preHandler: requireAdmin('operator') }, async (req, reply) => {
    const parsed = DlqIdParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const purged = await purgeDeadLetter(parsed.data.id);
    if (!purged) return reply.code(404).send({ error: 'not_found' });
    await auditAdminAction(req.admin!, 'dlq_delete', 'dead_letter', { id: parsed.data.id });
    return { deleted: parsed.data.id };
  });

  const DlqPurgeSchema = z.object({ confirm: z.literal(true) });
  app.post('/dlq/purge', { preHandler: requireAdmin('operator'), config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req, reply) => {
    const parsed = DlqPurgeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const purged = await purgeAllDeadLetters();
    await auditAdminAction(req.admin!, 'dlq_purge', 'dead_letter', { purged });
    return { purged };
  });

  // ---- Customer suspension / reinstatement ----
  const SuspendSchema = z.object({ customer_id: z.string().uuid(), reason: z.string().max(500).optional() });
  app.post('/customers/suspend', { preHandler: requireAdmin('admin') }, async (req, reply) => {
    const parsed = SuspendSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    await db.updateTable('customers').set({ status: 'suspended' }).where('id', '=', parsed.data.customer_id).execute();
    await auditAdminAction(req.admin!, 'suspend', 'customer', { reason: parsed.data.reason }, parsed.data.customer_id);
    return { suspended: parsed.data.customer_id };
  });

  app.post('/customers/reinstate', { preHandler: requireAdmin('admin') }, async (req, reply) => {
    const parsed = SuspendSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    await db.updateTable('customers').set({ status: 'active' }).where('id', '=', parsed.data.customer_id).execute();
    await auditAdminAction(req.admin!, 'reinstate', 'customer', {}, parsed.data.customer_id);
    return { reinstated: parsed.data.customer_id };
  });

  // ---- Deliverability ops ----
  app.get('/deliverability/pool-health', { preHandler: requireAdmin('support') }, async () => {
    return { pools: await evaluatePoolHealth() };
  });

  // Comprehensive per-pool reputation view: health metrics + IP details +
  // blocklist status + postmaster snapshots. One call for the ops dashboard.
  app.get('/reputation/pools', { preHandler: requireAdmin('support') }, async () => {
    const [poolHealth, sendingIps, recentBlocklists, recentSnapshots] = await Promise.all([
      evaluatePoolHealth(),
      db.selectFrom('sending_ips')
        .select(['id', 'ip', 'pool_id', 'ptr_record', 'warmup_stage', 'status', 'dedicated_customer_id', 'created_at'])
        .where('status', '!=', 'retired')
        .orderBy('pool_id', 'asc')
        .orderBy('ip', 'asc')
        .execute(),
      // Most recent blocklist check per IP (any listing in the past 7 days).
      db.selectFrom('blocklist_checks')
        .select(['ip', 'provider', 'listed', 'return_code', 'checked_at'])
        .where('listed', '=', true)
        .where(sql<boolean>`checked_at >= now() - interval '7 days'`)
        .orderBy('checked_at', 'desc')
        .execute(),
      // Latest postmaster snapshot per IP.
      db.selectFrom('ip_reputation')
        .select(['ip', 'snapshot_date', 'google_reputation', 'google_spam_rate', 'snds_color', 'bounce_rate', 'complaint_rate'])
        .where(sql<boolean>`snapshot_date >= current_date - interval '30 days'`)
        .orderBy('snapshot_date', 'desc')
        .execute(),
    ]);

    // Index health and reputation data by pool / IP for efficient merge.
    const healthByPool = new Map(poolHealth.map((h) => [h.pool, h]));
    const listingsByIp = new Map<string, typeof recentBlocklists>();
    for (const bl of recentBlocklists) {
      if (!listingsByIp.has(bl.ip)) listingsByIp.set(bl.ip, []);
      listingsByIp.get(bl.ip)!.push(bl);
    }
    // Keep only the latest snapshot per IP.
    const latestSnapshotByIp = new Map<string, typeof recentSnapshots[number]>();
    for (const s of recentSnapshots) {
      if (!latestSnapshotByIp.has(s.ip)) latestSnapshotByIp.set(s.ip, s);
    }

    // Group IPs by pool_id, merging in blocklist and postmaster data.
    const poolsMap = new Map<string, {
      pool_id: string;
      health: typeof poolHealth[number] | null;
      ips: Array<{
        ip: string;
        ptr_record: string | null;
        warmup_stage: number;
        status: string;
        dedicated_customer_id: string | null;
        blocklist_listings: typeof recentBlocklists;
        reputation_snapshot: typeof recentSnapshots[number] | null;
      }>;
    }>();

    for (const sip of sendingIps) {
      const poolKey = sip.pool_id ?? 'default';
      if (!poolsMap.has(poolKey)) {
        poolsMap.set(poolKey, { pool_id: poolKey, health: healthByPool.get(poolKey) ?? null, ips: [] });
      }
      poolsMap.get(poolKey)!.ips.push({
        ip: String(sip.ip),
        ptr_record: sip.ptr_record ?? null,
        warmup_stage: sip.warmup_stage,
        status: sip.status,
        dedicated_customer_id: sip.dedicated_customer_id ?? null,
        blocklist_listings: listingsByIp.get(String(sip.ip)) ?? [],
        reputation_snapshot: latestSnapshotByIp.get(String(sip.ip)) ?? null,
      });
    }

    // Include pools that have health data but no active IPs yet.
    for (const h of poolHealth) {
      if (!poolsMap.has(h.pool)) {
        poolsMap.set(h.pool, { pool_id: h.pool, health: h, ips: [] });
      }
    }

    return { pools: Array.from(poolsMap.values()) };
  });

  app.post('/deliverability/blocklist-scan', { preHandler: requireAdmin('operator') }, async (req) => {
    const listings = await monitorAllBlocklists();
    await auditAdminAction(req.admin!, 'blocklist_scan', 'sending_ips', { listings: listings.length });
    return { listings };
  });

  // ---- Key rotation (self-serve overlap window) ----
  const RotateSchema = z.object({ customer_id: z.string().uuid(), api_key_id: z.string().uuid(), name: z.string().max(100).optional() });
  app.post('/api-keys/rotate', { preHandler: requireAdmin('admin') }, async (req, reply) => {
    const parsed = RotateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const old = await db
      .selectFrom('api_keys')
      .selectAll()
      .where('id', '=', parsed.data.api_key_id)
      .where('customer_id', '=', parsed.data.customer_id)
      .executeTakeFirst();
    if (!old) return reply.code(404).send({ error: 'not_found' });

    const next = generateApiKeyV2(old.key_type as any);
    const row = await db
      .insertInto('api_keys')
      .values({
        customer_id: parsed.data.customer_id,
        name: parsed.data.name ?? `${old.name} (rotated)`,
        key_prefix: next.prefix,
        key_hash: next.hash,
        scopes: old.scopes,
        key_type: next.key_type,
        rotated_from: old.id,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    // Set an overlap window: the old key expires in 48h so clients can cut over.
    const overlapHours = Number(process.env.KEY_ROTATION_OVERLAP_HOURS ?? 48);
    await db
      .updateTable('api_keys')
      .set({ expires_at: new Date(Date.now() + overlapHours * 3600_000) })
      .where('id', '=', old.id)
      .execute();

    await auditAdminAction(req.admin!, 'rotate_key', old.id, { new_key_id: row.id }, parsed.data.customer_id);
    return reply.code(201).send({
      new_key_id: row.id,
      api_key: next.plaintext,
      old_key_expires_in_hours: overlapHours,
      note: 'Old key remains valid during the overlap window. Save the new key now.',
    });
  });

  // ---- Billing reconciliation ----
  app.post('/billing/reconcile', { preHandler: requireAdmin('operator') }, async (req, reply) => {
    const drift = await reconcileMetering();
    await auditAdminAction(req.admin!, 'billing_reconcile', 'platform',
      { total_drift: drift.totalDrift, customers_with_drift: drift.byCustomer.length } as unknown as Record<string, unknown>);
    return reply.code(200).send({
      ok: true,
      total_drift: drift.totalDrift,
      by_customer: drift.byCustomer,
      alert: drift.totalDrift !== 0 ? 'drift_detected' : 'clean',
    });
  });

  // ---- Retention / cleanup ----
  const RetentionTriggerSchema = z.object({
    message_body_retention_days: z.number().int().min(0).max(3650).optional(),
    event_retention_days: z.number().int().min(0).max(3650).optional(),
    audit_retention_days: z.number().int().min(0).max(3650).optional(),
    review_queue_retention_days: z.number().int().min(0).max(3650).optional(),
  });

  app.post('/retention/run', { preHandler: requireAdmin('operator') }, async (req, reply) => {
    const parsed = RetentionTriggerSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const result = await runRetention({
      messageBodyRetentionDays: parsed.data.message_body_retention_days,
      eventRetentionDays: parsed.data.event_retention_days,
      auditRetentionDays: parsed.data.audit_retention_days,
      reviewQueueRetentionDays: parsed.data.review_queue_retention_days,
    });
    await auditAdminAction(req.admin!, 'retention_run', 'platform', result as unknown as Record<string, unknown>);
    return reply.code(200).send({ ok: true, result });
  });

  // ---- Audit trail ----
  app.get('/audit', { preHandler: requireAdmin('admin') }, async (req) => {
    const { limit = '100' } = req.query as Record<string, string>;
    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', 'like', 'admin:%')
      .orderBy('occurred_at', 'desc')
      .limit(Math.min(Number(limit), 500))
      .execute();
    return { audit: rows };
  });

  // ---- Admin authentication (OIDC / SSO) ----
  //
  // Validates an id_token issued by any standards-compliant OIDC provider
  // (Google, Auth0, Okta, Cognito, …). The frontend handles the redirect flow
  // and passes the id_token here for verification.
  //
  // Required env vars: OIDC_ISSUER_URL, OIDC_CLIENT_ID
  // If either is unset the endpoint returns 503 so misconfiguration is
  // obvious rather than silently accepting unauthenticated requests.
  let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  async function getJwksForIssuer(issuerUrl: string): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (!_jwks) {
      const disc = await fetch(`${issuerUrl}/.well-known/openid-configuration`);
      if (!disc.ok) throw new Error(`OIDC discovery failed: ${disc.status}`);
      const config = (await disc.json()) as { jwks_uri: string };
      _jwks = createRemoteJWKSet(new URL(config.jwks_uri));
    }
    return _jwks;
  }

  const OidcLoginSchema = z.object({ id_token: z.string().min(1) });

  app.post('/auth/oidc-login', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '5 minutes',
        keyGenerator: (req) => `adminOidc:${req.ip}`,
        errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, error: 'rate_limited', message: `Too many login attempts. Retry in ${Math.ceil(ctx.ttl / 1000)}s.`, retry_after: Math.ceil(ctx.ttl / 1000) }),
      },
    },
  }, async (req, reply) => {
    const issuerUrl = process.env.OIDC_ISSUER_URL?.replace(/\/$/, '');
    const clientId = process.env.OIDC_CLIENT_ID;
    if (!issuerUrl || !clientId) {
      return reply.code(503).send({ error: 'oidc_not_configured', message: 'Set OIDC_ISSUER_URL and OIDC_CLIENT_ID to enable SSO login' });
    }

    const parsed = OidcLoginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });

    let sub: string;
    let email: string;
    try {
      const jwks = await getJwksForIssuer(issuerUrl);
      const { payload } = await jwtVerify(parsed.data.id_token, jwks, {
        issuer: issuerUrl,
        audience: clientId,
      });
      if (!payload.sub) throw new Error('missing sub claim');
      const rawEmail = (payload as Record<string, unknown>).email;
      if (typeof rawEmail !== 'string' || !rawEmail) throw new Error('missing email claim');
      sub = payload.sub;
      email = rawEmail.toLowerCase();
    } catch (err: any) {
      req.log.warn({ err: err.message }, 'OIDC id_token verification failed');
      return reply.code(401).send({ error: 'invalid_token', message: 'OIDC token verification failed' });
    }

    const session = await createAdminSession(sub, email);
    if (!session) {
      return reply.code(403).send({ error: 'not_authorized', message: 'No admin account found for this identity. Ask a superadmin to provision one.' });
    }

    return {
      token: session.token,
      role: session.role,
      expires_at: new Date(Date.now() + 8 * 3600_000).toISOString(),
    };
  });

  // ---- Admin authentication (password) ----
  const LoginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(256), code: z.string().min(1).max(20).optional() });
  app.post('/auth/login', {
    config: {
      rateLimit: {
        hook: 'preHandler',
        max: 5,
        timeWindow: '15 minutes',
        keyGenerator: (req) => {
          const body = req.body as Record<string, unknown> | null;
          const email = typeof body?.email === 'string' ? body.email.toLowerCase() : null;
          return `adminLogin:${email ?? req.ip}`;
        },
        errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, error: 'rate_limited', message: `Too many login attempts. Retry in ${Math.ceil(ctx.ttl / 1000)}s.`, retry_after: Math.ceil(ctx.ttl / 1000) }),
      },
    },
  }, async (req, reply) => {
    if (process.env.ADMIN_PASSWORD_LOGIN_DISABLED === 'true') {
      return reply.code(403).send({
        error: 'password_login_disabled',
        message: 'Password-based admin login is disabled. Use SSO/OIDC.',
      });
    }

    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });

    // Check lockout before attempting credential verification.
    const adminRow = await db
      .selectFrom('admin_users')
      .select(['id', 'failed_login_attempts', 'locked_until'])
      .where('email', '=', parsed.data.email.toLowerCase())
      .executeTakeFirst();
    if (adminRow?.locked_until && new Date(adminRow.locked_until) > new Date()) {
      const retryAfter = Math.ceil((new Date(adminRow.locked_until).getTime() - Date.now()) / 1000);
      reply.header('Retry-After', String(retryAfter));
      return reply.code(429).send({
        error: 'account_locked',
        message: `Account is locked due to repeated failed login attempts.`,
        retry_after: retryAfter,
      });
    }

    const auth = await verifyAdminPasswordCredentials(parsed.data.email, parsed.data.password);
    if (!auth) {
      // Increment failure counter and lock if threshold reached.
      if (adminRow) {
        const newCount = (adminRow.failed_login_attempts ?? 0) + 1;
        const lockedUntil = newCount >= 5 ? new Date(Date.now() + 15 * 60_000) : null;
        await db.updateTable('admin_users')
          .set({ failed_login_attempts: newCount, ...(lockedUntil ? { locked_until: lockedUntil } : {}) })
          .where('id', '=', adminRow.id)
          .execute();
      }
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    if (auth.totp_enabled) {
      if (!parsed.data.code) return reply.code(401).send({ error: 'mfa_required' });
      if (!(await verifyAdminTotp(auth.admin_user_id, parsed.data.code))) {
        // A correct password but wrong/replayed MFA code is still a failed login
        // attempt — count it toward lockout so MFA codes can't be brute-forced
        // (or replayed) without limit behind a known-good password.
        const newCount = (adminRow?.failed_login_attempts ?? 0) + 1;
        const lockedUntil = newCount >= 5 ? new Date(Date.now() + 15 * 60_000) : null;
        await db.updateTable('admin_users')
          .set({ failed_login_attempts: newCount, ...(lockedUntil ? { locked_until: lockedUntil } : {}) })
          .where('id', '=', auth.admin_user_id)
          .execute();
        return reply.code(401).send({ error: 'mfa_invalid' });
      }
    }

    // Reset lockout state on successful login.
    await db.updateTable('admin_users')
      .set({ failed_login_attempts: 0, locked_until: null })
      .where('id', '=', auth.admin_user_id)
      .execute();

    const session = await createAdminSessionForPasswordAuth(auth);
    return {
      token: session.token,
      role: session.role,
      expires_at: session.expires_at.toISOString(),
    };
  });

  app.post('/auth/mfa/enroll', { preHandler: requireAdmin('support') }, async (req, reply) => {
    const enrollment = await beginAdminTotpEnrollment(req.admin!.admin_user_id);
    if (!enrollment) return reply.code(404).send({ error: 'not_found' });
    await auditAdminAction(req.admin!, 'admin_mfa_enroll_begin', 'admin_user', { admin_user_id: req.admin!.admin_user_id });
    return enrollment;
  });

  const MfaCodeSchema = z.object({ code: z.string().min(1).max(20) });
  app.post('/auth/mfa/confirm', { preHandler: requireAdmin('support') }, async (req, reply) => {
    const parsed = MfaCodeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const ok = await confirmAdminTotpEnrollment(req.admin!.admin_user_id, parsed.data.code);
    if (!ok) return reply.code(400).send({ error: 'mfa_invalid' });
    await auditAdminAction(req.admin!, 'admin_mfa_confirm', 'admin_user', { admin_user_id: req.admin!.admin_user_id });
    return { ok: true, totp_enabled: true };
  });

  app.post('/auth/mfa/disable', { preHandler: requireAdmin('support') }, async (req, reply) => {
    const ok = await disableAdminTotp(req.admin!.admin_user_id);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    await auditAdminAction(req.admin!, 'admin_mfa_disable', 'admin_user', { admin_user_id: req.admin!.admin_user_id });
    return { ok: true, totp_enabled: false };
  });

  app.post('/auth/logout', { preHandler: requireAdmin('support') }, async (req) => {
    const header = req.headers.authorization!;
    await revokeAdminSession(header.slice(7).trim());
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: requireAdmin('support') }, async (req) => {
    return { admin_user_id: req.admin!.admin_user_id, email: req.admin!.email, role: req.admin!.role };
  });

  // ---- Admin user management (superadmin only) ----
  const ROLES = ['support', 'operator', 'admin', 'superadmin'] as const;
  app.get('/admins', { preHandler: requireAdmin('superadmin') }, async () => {
    return { admins: await listAdminUsers() };
  });

  const CreateAdminSchema = z.object({
    email: z.string().email(),
    name: z.string().max(200).optional(),
    role: z.enum(ROLES),
    password: z.string().min(12).max(256),
  });
  app.post('/admins', { preHandler: requireAdmin('superadmin') }, async (req, reply) => {
    const parsed = CreateAdminSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const result = await createAdminUser(parsed.data);
    if ('error' in result) return reply.code(409).send({ error: result.error });
    await auditAdminAction(req.admin!, 'create_admin', 'admin_user', { email: parsed.data.email, role: parsed.data.role });
    return reply.code(201).send({ id: result.id, email: parsed.data.email, role: parsed.data.role });
  });

  const UpdateAdminSchema = z.object({
    role: z.enum(ROLES).optional(),
    disabled: z.boolean().optional(),
    name: z.string().max(200).nullable().optional(),
  });
  app.patch('/admins/:id', { preHandler: requireAdmin('superadmin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateAdminSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    // Guard against a superadmin disabling or demoting themselves and locking
    // the org out of the only privileged account.
    if (id === req.admin!.admin_user_id && (parsed.data.disabled === true || (parsed.data.role && parsed.data.role !== 'superadmin'))) {
      return reply.code(400).send({ error: 'cannot_self_demote' });
    }
    const ok = await updateAdminUser(id, parsed.data);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    await auditAdminAction(req.admin!, 'update_admin', 'admin_user', { ...parsed.data }, undefined);
    return { updated: id };
  });

  const AdminPwSchema = z.object({ password: z.string().min(12).max(256) });
  app.post('/admins/:id/password', { preHandler: requireAdmin('superadmin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = AdminPwSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const ok = await setAdminPassword(id, parsed.data.password);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    await auditAdminAction(req.admin!, 'reset_admin_password', 'admin_user', { admin_user_id: id });
    return { ok: true };
  });

  // ---- Customer plan / quota management ----
  const UpdateCustomerSchema = z.object({
    tier: z.enum(['free', 'paid', 'enterprise']).optional(),
    daily_quota: z.number().int().min(0).max(100_000_000).optional(),
    monthly_quota: z.number().int().min(0).max(1_000_000_000).optional(),
  });
  app.patch('/customers/:id', { preHandler: requireAdmin('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateCustomerSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const set: Record<string, unknown> = {};
    if (parsed.data.tier !== undefined) set.tier = parsed.data.tier;
    if (parsed.data.daily_quota !== undefined) set.daily_quota = parsed.data.daily_quota;
    if (parsed.data.monthly_quota !== undefined) set.monthly_quota = parsed.data.monthly_quota;
    if (Object.keys(set).length === 0) return reply.code(400).send({ error: 'no_fields' });
    set.updated_at = new Date();
    const res = await db.updateTable('customers').set(set).where('id', '=', id).executeTakeFirst();
    if (Number(res.numUpdatedRows ?? 0) === 0) return reply.code(404).send({ error: 'not_found' });
    await auditAdminAction(req.admin!, 'update_customer', 'customer', { ...parsed.data }, id);
    return { updated: id, ...parsed.data };
  });

  // ---- Platform overview (dashboard data) ----
  app.get('/overview', { preHandler: requireAdmin('support') }, async () => {
    const since = new Date(Date.now() - 24 * 3600_000);
    const [customers, messages24h, queueDepth, suppressions] = await Promise.all([
      db.selectFrom('customers').select(['status', (eb) => eb.fn.countAll<number>().as('c')]).groupBy('status').execute(),
      db.selectFrom('messages').select(['status', (eb) => eb.fn.countAll<number>().as('c')]).where('queued_at', '>=', since as any).groupBy('status').execute(),
      sendQueue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
      db.selectFrom('suppressions').select((eb) => eb.fn.countAll<number>().as('c')).executeTakeFirst(),
    ]);
    const msgByStatus = Object.fromEntries(messages24h.map((r) => [r.status, Number(r.c)]));
    const totalSent24h = Object.values(msgByStatus).reduce((a, b) => a + b, 0);
    const bounced = (msgByStatus.hard_bounced ?? 0) + (msgByStatus.soft_bounced ?? 0);
    const delivered = msgByStatus.delivered ?? 0;
    return {
      customers_by_status: Object.fromEntries(customers.map((r) => [r.status, Number(r.c)])),
      messages_24h: { by_status: msgByStatus, total: totalSent24h },
      rates_24h: {
        bounce_rate: totalSent24h ? Number((bounced / totalSent24h).toFixed(4)) : 0,
        delivery_rate: totalSent24h ? Number((delivered / totalSent24h).toFixed(4)) : 0,
      },
      send_queue: queueDepth,
      suppressions_total: Number(suppressions?.c ?? 0),
    };
  });

  // ---- Support: SLA breaches (agent work queue) ----
  app.get('/support-tickets/sla-breaches', { preHandler: requireAdmin('support') }, async () => {
    return { breaches: await listSlaBreaches() };
  });

  // ---- Support: AI-suggested draft reply (never auto-sent) ----
  app.post('/support-tickets/:id/suggest-reply', { preHandler: requireAdmin('support') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const suggestion = await suggestSupportReply(id, req.admin!.email);
    if (!suggestion) return reply.code(404).send({ error: 'not_found' });
    return suggestion; // { draft, model }
  });

  // ---- Support: canned responses (agent macros) ----
  const CATS = ['general', 'billing', 'deliverability', 'technical', 'abuse', 'account'] as const;
  app.get('/support/canned-responses', { preHandler: requireAdmin('support') }, async (req) => {
    const { category } = req.query as { category?: string };
    const cat = CATS.includes(category as any) ? (category as (typeof CATS)[number]) : undefined;
    return { canned_responses: await listCannedResponses(cat) };
  });

  const CannedSchema = z.object({ title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(10000), category: z.enum(CATS).optional() });
  app.post('/support/canned-responses', { preHandler: requireAdmin('support') }, async (req, reply) => {
    const parsed = CannedSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const created = await createCannedResponse({ ...parsed.data, adminUserId: req.admin!.admin_user_id });
    await auditAdminAction(req.admin!, 'create_canned_response', 'support_canned_response', { id: created.id, title: created.title });
    return reply.code(201).send(created);
  });

  const CannedPatchSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), body: z.string().trim().min(1).max(10000).optional(), category: z.enum(CATS).optional() });
  app.patch('/support/canned-responses/:id', { preHandler: requireAdmin('support') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = CannedPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const ok = await updateCannedResponse(id, parsed.data);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    return { updated: id };
  });

  app.delete('/support/canned-responses/:id', { preHandler: requireAdmin('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deleteCannedResponse(id);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    await auditAdminAction(req.admin!, 'delete_canned_response', 'support_canned_response', { id });
    return { deleted: id };
  });

  // ─── Billing event replay (gap analysis 2.3.2) ─────────────────────────────
  // List processed provider billing events, inspect one (with its stored raw
  // payload), and replay a specific event. Replay re-parses the stored payload
  // through the same provider parser and re-applies the subscription state,
  // bypassing the idempotency guard (a replay is an intentional re-run).
  app.get('/billing-events', { preHandler: requireAdmin('operator') }, async (req) => {
    const { limit, before } = req.query as { limit?: string; before?: string };
    const events = await listBillingEvents({
      limit: limit ? parseInt(limit, 10) : undefined,
      before,
    });
    return { events };
  });

  app.get('/billing-events/:id', { preHandler: requireAdmin('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const event = await getBillingEvent(decodeURIComponent(id));
    if (!event) return reply.code(404).send({ error: 'not_found' });
    return event;
  });

  app.post('/billing-events/:id/replay', {
    preHandler: requireAdmin('admin'), // replay mutates billing state — admin only
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const providerEventId = decodeURIComponent(id);
    const event = await getBillingEvent(providerEventId);
    if (!event) return reply.code(404).send({ error: 'not_found' });
    if (!event.replayable || event.payload == null) {
      return reply.code(422).send({
        error: 'not_replayable',
        message: 'This event predates raw-payload storage (035_billing_event_payload.sql) and cannot be replayed.',
      });
    }

    // Re-parse the stored raw payload through the SAME provider parser used at
    // ingest, then re-apply. We re-parse rather than trusting a cached parsed
    // form so a parser bugfix takes effect on replay.
    const provider = event.provider ?? 'stripe';
    const parsed = provider === 'stripe' ? stripeSubscriptionEvent(event.payload as any)
      : provider === 'cashfree' ? cashfreeSubscriptionEvent(event.payload as any)
      : paypalSubscriptionEvent(event.payload as any);

    if (!parsed) {
      return reply.code(422).send({ error: 'unparseable_payload', message: 'Stored payload did not parse into a subscription event.' });
    }

    // Force a fresh apply: a replay must NOT be short-circuited by the
    // idempotency marker, so use a synthetic provider_event_id suffix for the
    // dedupe insert while preserving the original for state lookups is not
    // needed — applySubscriptionState dedupes on provider_event_id, so we mark
    // the replay bookkeeping separately and re-run the state mutation directly.
    // Simplest correct approach: delete-then-reapply is unsafe; instead we call
    // applySubscriptionState with a replay marker id so it always applies.
    const applied = await applySubscriptionState({
      ...parsed,
      provider_event_id: `${parsed.provider_event_id}:replay:${Date.now()}`,
      raw_payload: event.payload,
    });

    await replayBillingEvent(providerEventId); // record replay bookkeeping
    await auditAdminAction(req.admin!, 'billing_event_replay', 'billing_event', { provider_event_id: providerEventId, provider, applied });
    return { replayed: providerEventId, applied };
  });
};
