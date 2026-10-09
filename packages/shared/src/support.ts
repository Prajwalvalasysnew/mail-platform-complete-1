import { sql, type Selectable } from 'kysely';
import { db } from './db.js';
import type {
  SupportTicketCategory,
  SupportTicketPriority,
  SupportTicketStatus,
  SupportTicketReadsTable,
} from './schema.js';
import { getInferenceProvider } from './inference.js';

// SLA targets in minutes by priority: [first response, resolution]. Mirrors a
// typical ESP support policy (urgent < high < normal < low).
const SLA_POLICY: Record<SupportTicketPriority, { firstResponse: number; resolution: number }> = {
  urgent: { firstResponse: 60, resolution: 8 * 60 },
  high: { firstResponse: 4 * 60, resolution: 24 * 60 },
  normal: { firstResponse: 24 * 60, resolution: 72 * 60 },
  low: { firstResponse: 48 * 60, resolution: 120 * 60 },
};

function slaDueTimes(priority: SupportTicketPriority, from: Date): { firstResponseDue: Date; resolutionDue: Date } {
  const p = SLA_POLICY[priority];
  return {
    firstResponseDue: new Date(from.getTime() + p.firstResponse * 60_000),
    resolutionDue: new Date(from.getTime() + p.resolution * 60_000),
  };
}

/** Derived SLA state for a ticket row (computed, never stored). */
export function computeSlaState(t: {
  status: string;
  first_response_due_at: Date | string | null;
  resolution_due_at: Date | string | null;
  first_responded_at: Date | string | null;
  resolved_at: Date | string | null;
}, now: Date = new Date()) {
  const open = t.status === 'open' || t.status === 'pending';
  const frDue = t.first_response_due_at ? new Date(t.first_response_due_at) : null;
  const resDue = t.resolution_due_at ? new Date(t.resolution_due_at) : null;
  const firstResponseBreached = !t.first_responded_at && open && !!frDue && now > frDue;
  const resolutionBreached = !t.resolved_at && open && !!resDue && now > resDue;
  return { firstResponseBreached, resolutionBreached, breached: firstResponseBreached || resolutionBreached };
}

export interface SupportCustomerQueryRaw {
  q?: string;
  status?: string;
  tier?: string;
  limit?: string | number;
  before?: string;
}

export interface SupportCustomerQuery {
  q?: string;
  status?: 'active' | 'suspended' | 'banned';
  tier?: 'free' | 'paid' | 'enterprise';
  limit: number;
  before?: string;
}

const CUSTOMER_STATUSES = ['active', 'suspended', 'banned'] as const;
const CUSTOMER_TIERS = ['free', 'paid', 'enterprise'] as const;

function safeLimit(v: unknown): number {
  const n = parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 200);
}

function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

export function normalizeSupportCustomerQuery(raw: SupportCustomerQueryRaw): SupportCustomerQuery {
  return {
    q: text(raw.q, 200),
    status: CUSTOMER_STATUSES.includes(raw.status as any) ? (raw.status as SupportCustomerQuery['status']) : undefined,
    tier: CUSTOMER_TIERS.includes(raw.tier as any) ? (raw.tier as SupportCustomerQuery['tier']) : undefined,
    limit: safeLimit(raw.limit),
    before: text(raw.before, 64),
  };
}

export async function listSupportCustomers(q: SupportCustomerQuery) {
  let query = db
    .selectFrom('customers')
    .select([
      'id',
      'email',
      'name',
      'tier',
      'status',
      'billing_status',
      'kyc_level',
      'kyc_status',
      'kyc_note',
      'kyc_submitted_at',
      'kyc_reviewed_at',
      'daily_quota',
      'monthly_quota',
      'created_at',
      'updated_at',
      sql<number>`(select count(*) from messages m where m.customer_id = customers.id and m.queued_at >= now() - interval '7 days')`.as('messages_7d'),
      sql<number>`(select count(*) from messages m where m.customer_id = customers.id and m.queued_at >= now() - interval '7 days' and m.status in ('hard_bounced','soft_bounced'))`.as('bounced_7d'),
      sql<number>`(select count(*) from sending_domains d where d.customer_id = customers.id)`.as('domain_count'),
      sql<Date | null>`(select max(m.queued_at) from messages m where m.customer_id = customers.id)`.as('last_active_at'),
      sql<number>`coalesce((select i.amount_cents from invoices i where i.customer_id = customers.id and i.status in ('open','paid') order by i.period_end desc limit 1), 0)`.as('mrr_cents'),
    ]);

  if (q.status) query = query.where('status', '=', q.status);
  if (q.tier) query = query.where('tier', '=', q.tier);
  if (q.before) query = query.where('id', '<', q.before);
  if (q.q) {
    const needle = `%${q.q.toLowerCase()}%`;
    query = query.where((eb) =>
      eb.or([
        sql<boolean>`lower(email) like ${needle}`,
        sql<boolean>`lower(coalesce(name, '')) like ${needle}`,
        sql<boolean>`id::text = ${q.q}`,
      ])
    );
  }

  const rows = await query.orderBy('id', 'desc').limit(q.limit + 1).execute();
  const hasMore = rows.length > q.limit;
  const customers = hasMore ? rows.slice(0, q.limit) : rows;
  return { customers, next_cursor: hasMore ? customers.at(-1)!.id : null };
}

export async function getSupportCustomerOverview(customerId: string) {
  const customer = await db
    .selectFrom('customers')
    .selectAll()
    .select([
      sql<number>`(select count(*) from messages m where m.customer_id = customers.id and m.queued_at >= now() - interval '7 days')`.as('messages_7d'),
      sql<number>`(select count(*) from messages m where m.customer_id = customers.id and m.queued_at >= now() - interval '7 days' and m.status in ('hard_bounced','soft_bounced'))`.as('bounced_7d'),
      sql<number>`(select count(*) from sending_domains d where d.customer_id = customers.id)`.as('domain_count'),
      sql<Date | null>`(select max(m.queued_at) from messages m where m.customer_id = customers.id)`.as('last_active_at'),
      sql<number>`coalesce((select i.amount_cents from invoices i where i.customer_id = customers.id and i.status in ('open','paid') order by i.period_end desc limit 1), 0)`.as('mrr_cents'),
    ])
    .where('id', '=', customerId)
    .executeTakeFirst();
  if (!customer) return null;

  const [members, apiKeys, domains, recentMessages, usage, notes, audit, resources, billing] = await Promise.all([
    db
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .select(['users.id', 'users.email', 'users.name', 'users.status', 'users.mfa_enabled', 'memberships.role'])
      .where('memberships.customer_id', '=', customerId)
      .orderBy('users.email', 'asc')
      .execute(),
    db
      .selectFrom('api_keys')
      .select(['id', 'name', 'key_prefix', 'scopes', 'key_type', 'last_used_at', 'expires_at', 'revoked_at', 'created_at'])
      .where('customer_id', '=', customerId)
      .orderBy('created_at', 'desc')
      .limit(25)
      .execute(),
    db
      .selectFrom('sending_domains')
      .select(['id', 'domain', 'verified_at', 'spf_verified', 'dkim_verified', 'dmarc_verified', 'created_at'])
      .where('customer_id', '=', customerId)
      .orderBy('created_at', 'desc')
      .execute(),
    db
      .selectFrom('messages')
      .select(['message_id', 'from_address', 'to_address', 'subject', 'status', 'queued_at', 'accepted_at', 'delivered_at', 'bounced_at'])
      .where('customer_id', '=', customerId)
      .orderBy('queued_at', 'desc')
      .limit(10)
      .execute(),
    db
      .selectFrom('usage_daily')
      .select(['usage_date', 'sent', 'delivered', 'bounced', 'complained'])
      .where('customer_id', '=', customerId)
      .where(sql<boolean>`usage_date >= (CURRENT_DATE - 30 * INTERVAL '1 day')`)
      .orderBy('usage_date', 'desc')
      .execute(),
    db
      .selectFrom('support_notes')
      .innerJoin('admin_users', 'admin_users.id', 'support_notes.admin_user_id')
      .select([
        'support_notes.id',
        'support_notes.body',
        'support_notes.visibility',
        'support_notes.created_at',
        'admin_users.email as admin_email',
        'admin_users.role as admin_role',
      ])
      .where('support_notes.customer_id', '=', customerId)
      .orderBy('support_notes.created_at', 'desc')
      .limit(10)
      .execute(),
    db
      .selectFrom('audit_log')
      .select(['id', 'action', 'resource', 'actor_type', 'actor_label', 'metadata', 'occurred_at'])
      .where('customer_id', '=', customerId)
      .orderBy('id', 'desc')
      .limit(20)
      .execute(),
    db.selectFrom('customers').select([
      sql<number>`(select count(*) from webhooks w where w.customer_id = customers.id)`.as('webhook_count'),
      sql<number>`(select count(*) from suppressions s where s.customer_id = customers.id)`.as('suppression_count'),
      sql<number>`(select count(*) from support_tickets t where t.customer_id = customers.id and t.status in ('open','pending'))`.as('ticket_count'),
    ]).where('id', '=', customerId).executeTakeFirst(),
    db.selectFrom('invoices').select(['amount_cents', 'status', 'period_end']).where('customer_id', '=', customerId).orderBy('period_end', 'desc').limit(1).executeTakeFirst(),
  ]);

  return { customer, members, api_keys: apiKeys, domains, recent_messages: recentMessages, usage_30d: usage, support_notes: notes, audit, resources, billing };
}

export async function createSupportNote(input: {
  customerId: string;
  adminUserId: string;
  body: string;
  visibility?: 'internal' | 'escalation';
}) {
  return db
    .insertInto('support_notes')
    .values({
      customer_id: input.customerId,
      admin_user_id: input.adminUserId,
      body: input.body,
      visibility: input.visibility ?? 'internal',
    })
    .returning(['id', 'customer_id', 'admin_user_id', 'body', 'visibility', 'created_at'])
    .executeTakeFirstOrThrow();
}

export async function listSupportNotes(customerId: string, limit = 50) {
  return db
    .selectFrom('support_notes')
    .leftJoin('admin_users', 'admin_users.id', 'support_notes.admin_user_id')
    .select([
      'support_notes.id',
      'support_notes.body',
      'support_notes.visibility',
      'support_notes.created_at',
      'admin_users.email as admin_email',
      'admin_users.role as admin_role',
    ])
    .where('support_notes.customer_id', '=', customerId)
    .orderBy('support_notes.created_at', 'desc')
    .limit(Math.max(1, Math.min(limit, 200)))
    .execute();
}

export interface SupportTicketQueryRaw {
  customer_id?: string;
  status?: string;
  priority?: string;
  category?: string;
  assigned?: string;
  limit?: string | number;
  before?: string;
}

export interface SupportTicketQuery {
  customerId?: string;
  status?: SupportTicketStatus;
  priority?: SupportTicketPriority;
  category?: SupportTicketCategory;
  assigned?: 'me' | 'unassigned';
  limit: number;
  before?: string;
}

const TICKET_STATUSES: SupportTicketStatus[] = ['open', 'pending', 'resolved', 'closed'];
const TICKET_PRIORITIES: SupportTicketPriority[] = ['low', 'normal', 'high', 'urgent'];
const TICKET_CATEGORIES: SupportTicketCategory[] = ['general', 'billing', 'deliverability', 'technical', 'abuse', 'account'];

export function normalizeSupportTicketQuery(raw: SupportTicketQueryRaw): SupportTicketQuery {
  const assigned = raw.assigned === 'me' || raw.assigned === 'unassigned' ? raw.assigned : undefined;
  return {
    customerId: text(raw.customer_id, 64),
    status: TICKET_STATUSES.includes(raw.status as any) ? (raw.status as SupportTicketStatus) : undefined,
    priority: TICKET_PRIORITIES.includes(raw.priority as any) ? (raw.priority as SupportTicketPriority) : undefined,
    category: TICKET_CATEGORIES.includes(raw.category as any) ? (raw.category as SupportTicketCategory) : undefined,
    assigned,
    limit: safeLimit(raw.limit),
    before: text(raw.before, 64),
  };
}

export async function listSupportTickets(q: SupportTicketQuery, adminUserId?: string) {
  let query = db
    .selectFrom('support_tickets')
    .innerJoin('customers', 'customers.id', 'support_tickets.customer_id')
    .leftJoin('admin_users', 'admin_users.id', 'support_tickets.assigned_admin_user_id')
    .select([
      'support_tickets.id',
      'support_tickets.customer_id',
      'customers.email as customer_email',
      'customers.name as customer_name',
      'support_tickets.subject',
      'support_tickets.status',
      'support_tickets.priority',
      'support_tickets.category',
      'support_tickets.assigned_admin_user_id',
      'admin_users.email as assigned_admin_email',
      'support_tickets.ai_summary',
      'support_tickets.ai_suggested_priority',
      'support_tickets.ai_suggested_category',
      'support_tickets.ai_confidence',
      'support_tickets.ai_labels',
      'support_tickets.ai_model',
      'support_tickets.ai_triaged_at',
      'support_tickets.last_message_at',
      'support_tickets.created_at',
      'support_tickets.updated_at',
    ]);

  if (q.customerId) query = query.where('support_tickets.customer_id', '=', q.customerId);
  if (q.status) query = query.where('support_tickets.status', '=', q.status);
  if (q.priority) query = query.where('support_tickets.priority', '=', q.priority);
  if (q.category) query = query.where('support_tickets.category', '=', q.category);
  if (q.assigned === 'me' && adminUserId) query = query.where('support_tickets.assigned_admin_user_id', '=', adminUserId);
  if (q.assigned === 'unassigned') query = query.where('support_tickets.assigned_admin_user_id', 'is', null);
  if (q.before) query = query.where('support_tickets.id', '<', q.before);

  const rows = await query.orderBy('support_tickets.last_message_at', 'desc').orderBy('support_tickets.id', 'desc').limit(q.limit + 1).execute();
  const hasMore = rows.length > q.limit;
  const tickets = hasMore ? rows.slice(0, q.limit) : rows;
  return { tickets, next_cursor: hasMore ? tickets.at(-1)!.id : null };
}

export async function createSupportTicket(input: {
  customerId: string;
  subject: string;
  body: string;
  priority?: SupportTicketPriority;
  category?: SupportTicketCategory;
  createdByUserId?: string | null;
  adminUserId?: string | null;
}) {
  return db.transaction().execute(async (trx) => {
    const now = new Date();
    const priority = input.priority ?? 'normal';
    const { firstResponseDue, resolutionDue } = slaDueTimes(priority, now);
    const ticket = await trx
      .insertInto('support_tickets')
      .values({
        customer_id: input.customerId,
        subject: input.subject,
        priority,
        category: input.category ?? 'general',
        created_by_user_id: input.createdByUserId ?? null,
        assigned_admin_user_id: input.adminUserId ?? null,
        first_response_due_at: firstResponseDue,
        resolution_due_at: resolutionDue,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('support_ticket_messages')
      .values({
        ticket_id: ticket.id,
        author_type: input.adminUserId ? 'admin' : input.createdByUserId ? 'customer_user' : 'system',
        author_admin_user_id: input.adminUserId ?? null,
        author_user_id: input.adminUserId ? null : input.createdByUserId ?? null,
        body: input.body,
        internal: false,
      })
      .execute();

    if (input.createdByUserId) {
      await trx
        .insertInto('support_ticket_reads')
        .values({
          ticket_id: ticket.id,
          viewer_type: 'customer_user',
          viewer_user_id: input.createdByUserId,
          viewer_admin_user_id: null,
          last_read_at: ticket.last_message_at,
        } as any)
        .execute();
    }

    return ticket;
  });
}

export async function getSupportTicket(ticketId: string, opts: { customerId?: string; includeInternal?: boolean } = {}) {
  const ticket = await db
    .selectFrom('support_tickets')
    .innerJoin('customers', 'customers.id', 'support_tickets.customer_id')
    .leftJoin('admin_users', 'admin_users.id', 'support_tickets.assigned_admin_user_id')
    .select([
      'support_tickets.id',
      'support_tickets.customer_id',
      'customers.email as customer_email',
      'customers.name as customer_name',
      'support_tickets.subject',
      'support_tickets.status',
      'support_tickets.priority',
      'support_tickets.category',
      'support_tickets.created_by_user_id',
      'support_tickets.assigned_admin_user_id',
      'admin_users.email as assigned_admin_email',
      'support_tickets.ai_summary',
      'support_tickets.ai_suggested_priority',
      'support_tickets.ai_suggested_category',
      'support_tickets.ai_confidence',
      'support_tickets.ai_labels',
      'support_tickets.ai_model',
      'support_tickets.ai_triaged_at',
      'support_tickets.last_message_at',
      'support_tickets.resolved_at',
      'support_tickets.satisfaction_rating',
      'support_tickets.satisfaction_comment',
      'support_tickets.rated_at',
      'support_tickets.created_at',
      'support_tickets.updated_at',
    ])
    .where('support_tickets.id', '=', ticketId)
    .$if(!!opts.customerId, (qb) => qb.where('support_tickets.customer_id', '=', opts.customerId!))
    .executeTakeFirst();
  if (!ticket) return null;

  const messages = await db
    .selectFrom('support_ticket_messages')
    .leftJoin('users', 'users.id', 'support_ticket_messages.author_user_id')
    .leftJoin('admin_users', 'admin_users.id', 'support_ticket_messages.author_admin_user_id')
    .select([
      'support_ticket_messages.id',
      'support_ticket_messages.author_type',
      'support_ticket_messages.author_user_id',
      'users.email as author_user_email',
      'support_ticket_messages.author_admin_user_id',
      'admin_users.email as author_admin_email',
      'support_ticket_messages.body',
      'support_ticket_messages.internal',
      'support_ticket_messages.created_at',
    ])
    .where('support_ticket_messages.ticket_id', '=', ticketId)
    .$if(!opts.includeInternal, (qb) => qb.where('support_ticket_messages.internal', '=', false))
    .orderBy('support_ticket_messages.created_at', 'asc')
    .execute();

  return { ticket, messages };
}

export async function appendSupportTicketMessage(input: {
  ticketId: string;
  adminUserId?: string;
  userId?: string;
  customerId?: string;
  body: string;
  internal?: boolean;
}) {
  return db.transaction().execute(async (trx) => {
    const ticket = await trx
      .selectFrom('support_tickets')
      .select(['id', 'customer_id', 'first_responded_at'])
      .where('id', '=', input.ticketId)
      .$if(!!input.customerId, (qb) => qb.where('customer_id', '=', input.customerId!))
      .executeTakeFirst();
    if (!ticket) return null;
    if (!input.adminUserId && !input.userId) throw new Error('support message author required');
    if (input.userId && input.internal) throw new Error('customer messages cannot be internal');

    const msg = await trx
      .insertInto('support_ticket_messages')
      .values({
        ticket_id: input.ticketId,
        author_type: input.adminUserId ? 'admin' : 'customer_user',
        author_admin_user_id: input.adminUserId ?? null,
        author_user_id: input.adminUserId ? null : input.userId!,
        body: input.body,
        internal: input.internal ?? false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const ticketPatch: Record<string, unknown> = { last_message_at: new Date() };
    if (!input.internal) ticketPatch.status = input.adminUserId ? 'pending' : 'open';
    // Stamp the SLA first-response time on the first non-internal agent reply.
    if (input.adminUserId && !input.internal && !ticket.first_responded_at) {
      ticketPatch.first_responded_at = new Date();
    }
    await trx.updateTable('support_tickets').set(ticketPatch as any).where('id', '=', input.ticketId).execute();

    return msg;
  });
}

export async function listCustomerSupportTickets(customerId: string, q: SupportTicketQuery) {
  return listSupportTickets({ ...q, customerId }, undefined);
}

export async function markSupportTicketRead(input: {
  ticketId: string;
  viewerType: 'customer_user' | 'admin';
  viewerUserId?: string;
  viewerAdminUserId?: string;
  customerId?: string;
}): Promise<Selectable<SupportTicketReadsTable> | null> {
  const customerScope = input.customerId
    ? sql`and ticket.customer_id = ${input.customerId}::uuid`
    : sql``;

  // One INSERT .. SELECT .. ON CONFLICT statement is required here. The former
  // UPDATE-then-INSERT sequence let two browser effects both observe no marker
  // and race into the partial unique index, returning an avoidable HTTP 500.
  // Using the database clock also avoids cross-host clock skew.
  if (input.viewerType === 'customer_user') {
    if (!input.viewerUserId) throw new Error('viewerUserId is required for a customer read marker');
    const result = await sql<Selectable<SupportTicketReadsTable>>`
      insert into support_ticket_reads (
        ticket_id, viewer_type, viewer_user_id, viewer_admin_user_id,
        last_read_at, updated_at
      )
      select ticket.id, 'customer_user', ${input.viewerUserId}::uuid, null,
             current_timestamp, current_timestamp
      from support_tickets ticket
      where ticket.id = ${input.ticketId}::uuid
      ${customerScope}
      on conflict (ticket_id, viewer_user_id)
        where viewer_type = 'customer_user'
      do update set
        last_read_at = current_timestamp,
        updated_at = current_timestamp
      returning *
    `.execute(db);
    return result.rows[0] ?? null;
  }

  if (!input.viewerAdminUserId) throw new Error('viewerAdminUserId is required for an admin read marker');
  const result = await sql<Selectable<SupportTicketReadsTable>>`
    insert into support_ticket_reads (
      ticket_id, viewer_type, viewer_user_id, viewer_admin_user_id,
      last_read_at, updated_at
    )
    select ticket.id, 'admin', null, ${input.viewerAdminUserId}::uuid,
           current_timestamp, current_timestamp
    from support_tickets ticket
    where ticket.id = ${input.ticketId}::uuid
    ${customerScope}
    on conflict (ticket_id, viewer_admin_user_id)
      where viewer_type = 'admin'
    do update set
      last_read_at = current_timestamp,
      updated_at = current_timestamp
    returning *
  `.execute(db);
  return result.rows[0] ?? null;
}

export async function countUnreadSupportTickets(input: {
  viewerType: 'customer_user' | 'admin';
  viewerUserId?: string;
  viewerAdminUserId?: string;
  customerId?: string;
}) {
  let query = db
    .selectFrom('support_tickets')
    .leftJoin('support_ticket_reads', (join) =>
      input.viewerType === 'customer_user'
        ? join
            .onRef('support_ticket_reads.ticket_id', '=', 'support_tickets.id')
            .on('support_ticket_reads.viewer_type', '=', 'customer_user')
            .on('support_ticket_reads.viewer_user_id', '=', input.viewerUserId!)
        : join
            .onRef('support_ticket_reads.ticket_id', '=', 'support_tickets.id')
            .on('support_ticket_reads.viewer_type', '=', 'admin')
            .on('support_ticket_reads.viewer_admin_user_id', '=', input.viewerAdminUserId!)
    )
    .select(db.fn.countAll().as('count'))
    .where('support_tickets.status', 'in', ['open', 'pending'])
    .where((eb) =>
      eb.or([
        eb('support_ticket_reads.last_read_at', 'is', null),
        eb('support_ticket_reads.last_read_at', '<', eb.ref('support_tickets.last_message_at')),
      ])
    );

  if (input.customerId) query = query.where('support_tickets.customer_id', '=', input.customerId);
  if (input.viewerType === 'admin') {
    query = query.where((eb) =>
      eb.or([
        eb('support_tickets.assigned_admin_user_id', 'is', null),
        eb('support_tickets.assigned_admin_user_id', '=', input.viewerAdminUserId!),
      ])
    );
  }

  const row = await query.executeTakeFirst();
  return Number((row as any)?.count ?? 0);
}

export async function updateSupportTicket(input: {
  ticketId: string;
  status?: SupportTicketStatus;
  priority?: SupportTicketPriority;
  category?: SupportTicketCategory;
  assignedAdminUserId?: string | null;
}) {
  const patch: Record<string, unknown> = {};
  if (input.status) {
    patch.status = input.status;
    patch.resolved_at = input.status === 'resolved' || input.status === 'closed' ? new Date() : null;
  }
  if (input.priority) patch.priority = input.priority;
  if (input.category) patch.category = input.category;
  if (input.assignedAdminUserId !== undefined) patch.assigned_admin_user_id = input.assignedAdminUserId;
  if (Object.keys(patch).length === 0) return null;

  // Changing priority re-anchors the SLA due times off the original creation time.
  if (input.priority) {
    const existing = await db.selectFrom('support_tickets').select(['created_at']).where('id', '=', input.ticketId).executeTakeFirst();
    if (existing) {
      const due = slaDueTimes(input.priority, new Date(existing.created_at as any));
      patch.first_response_due_at = due.firstResponseDue;
      patch.resolution_due_at = due.resolutionDue;
    }
  }

  return db
    .updateTable('support_tickets')
    .set(patch as any)
    .where('id', '=', input.ticketId)
    .returningAll()
    .executeTakeFirst();
}

export async function triageSupportTicket(ticketId: string) {
  const detail = await getSupportTicket(ticketId);
  if (!detail) return null;

  const result = await getInferenceProvider().triageSupportTicket({
    subject: detail.ticket.subject,
    messages: detail.messages.map((m) => ({
      body: m.body,
      internal: m.internal,
      author_type: m.author_type,
    })),
    customer: {
      tier: undefined,
      status: undefined,
      billing_status: undefined,
    },
  });

  const row = await db
    .updateTable('support_tickets')
    .set({
      ai_summary: result.summary,
      ai_suggested_priority: result.suggested_priority,
      ai_suggested_category: result.suggested_category,
      ai_confidence: result.confidence,
      ai_labels: result.labels,
      ai_model: result.model,
      ai_triaged_at: new Date(),
    } as any)
    .where('id', '=', ticketId)
    .returningAll()
    .executeTakeFirstOrThrow();

  return { ticket: row, triage: result };
}

// ---------------------------------------------------------------------------
// CSAT — customer satisfaction rating on a resolved/closed ticket.
// ---------------------------------------------------------------------------
export async function rateSupportTicket(input: {
  ticketId: string;
  customerId: string;
  rating: number;
  comment?: string | null;
}): Promise<{ ok: true } | { error: 'not_found' | 'not_rateable' }> {
  const ticket = await db
    .selectFrom('support_tickets')
    .select(['id', 'status'])
    .where('id', '=', input.ticketId)
    .where('customer_id', '=', input.customerId)
    .executeTakeFirst();
  if (!ticket) return { error: 'not_found' };
  if (ticket.status !== 'resolved' && ticket.status !== 'closed') return { error: 'not_rateable' };
  await db
    .updateTable('support_tickets')
    .set({ satisfaction_rating: input.rating, satisfaction_comment: input.comment ?? null, rated_at: new Date() } as any)
    .where('id', '=', input.ticketId)
    .execute();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Canned responses (agent macros).
// ---------------------------------------------------------------------------
export async function listCannedResponses(category?: SupportTicketCategory) {
  let q = db.selectFrom('support_canned_responses').select(['id', 'title', 'body', 'category', 'created_at', 'updated_at']).orderBy('title', 'asc');
  if (category) q = q.where('category', '=', category);
  return q.execute();
}

export async function createCannedResponse(input: { title: string; body: string; category?: SupportTicketCategory; adminUserId: string }) {
  return db
    .insertInto('support_canned_responses')
    .values({ title: input.title, body: input.body, category: input.category ?? 'general', created_by_admin_user_id: input.adminUserId } as any)
    .returning(['id', 'title', 'body', 'category'])
    .executeTakeFirstOrThrow();
}

export async function updateCannedResponse(id: string, patch: { title?: string; body?: string; category?: SupportTicketCategory }): Promise<boolean> {
  const set: Record<string, unknown> = {};
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.body !== undefined) set.body = patch.body;
  if (patch.category !== undefined) set.category = patch.category;
  if (Object.keys(set).length === 0) return false;
  set.updated_at = new Date();
  const res = await db.updateTable('support_canned_responses').set(set as any).where('id', '=', id).executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0) > 0;
}

export async function deleteCannedResponse(id: string): Promise<boolean> {
  const res = await db.deleteFrom('support_canned_responses').where('id', '=', id).executeTakeFirst();
  return Number(res.numDeletedRows ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// AI suggested reply (draft only — never auto-sent).
// ---------------------------------------------------------------------------
export async function suggestSupportReply(ticketId: string, agentName?: string) {
  const detail = await getSupportTicket(ticketId, { includeInternal: true });
  if (!detail) return null;
  const result = await getInferenceProvider().suggestSupportReply({
    subject: detail.ticket.subject,
    category: detail.ticket.category as SupportTicketCategory,
    messages: detail.messages.map((m) => ({ body: m.body, internal: m.internal, author_type: m.author_type })),
    agentName,
  });
  return result;
}

// ---------------------------------------------------------------------------
// SLA breaches — open/pending tickets past their first-response or resolution
// due time. Used by the agent queue to surface what needs attention now.
// ---------------------------------------------------------------------------
export async function listSlaBreaches(limit = 100) {
  const now = new Date();
  const rows = await db
    .selectFrom('support_tickets')
    .innerJoin('customers', 'customers.id', 'support_tickets.customer_id')
    .select([
      'support_tickets.id as id', 'support_tickets.subject as subject', 'support_tickets.status as status',
      'support_tickets.priority as priority', 'support_tickets.category as category',
      'support_tickets.assigned_admin_user_id as assigned_admin_user_id',
      'support_tickets.first_response_due_at as first_response_due_at',
      'support_tickets.resolution_due_at as resolution_due_at',
      'support_tickets.first_responded_at as first_responded_at',
      'support_tickets.resolved_at as resolved_at',
      'customers.email as customer_email',
    ])
    .where('support_tickets.status', 'in', ['open', 'pending'])
    .where((eb) =>
      eb.or([
        eb.and([eb('support_tickets.first_responded_at', 'is', null), eb('support_tickets.first_response_due_at', '<', now as any)]),
        eb('support_tickets.resolution_due_at', '<', now as any),
      ])
    )
    .orderBy('support_tickets.priority', 'asc')
    .orderBy('support_tickets.first_response_due_at', 'asc')
    .limit(limit)
    .execute();
  return rows.map((r) => ({ ...r, sla: computeSlaState(r, now) })).filter((r) => r.sla.breached);
}
