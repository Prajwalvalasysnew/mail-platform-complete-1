// HIPAA-07 (compliance implementation plan): recording staff access to tenant
// personal data, and reviewing the access that warrants it.
//
// HIPAA §164.312(b) requires recording activity in systems holding ePHI; SOC 2
// CC6, ISO 27001 A.8.15 and GDPR Art 32 ask the same question in different
// words. On this platform, PHI is a prohibited workload (BASE-15) — but the
// control is not about PHI. It is about being able to answer "who looked at
// this customer's data, and was that appropriate", and that question was
// unanswerable here.
//
// THE GAP THIS CLOSES: WRITES WERE AUDITED, READS WERE NOT.
//
// Every privileged mutation went through auditAdminAction(). Reads went
// through it only where a developer remembered — GET /admin/customers/:id
// logged, GET /admin/customers/:id/support-notes did not. Support notes are
// free text about a named customer. Reading them left no trace at all.
//
// Adding the missing calls by hand would fix today and drift again by the next
// route, so the recording is a hook over the whole admin plane instead, and it
// is DEFAULT-ON: a route added tomorrow is audited without anyone thinking
// about it, and a route that genuinely exposes no tenant data has to say so
// explicitly. The polarity matters — with opt-in, the failure mode is silence.

import { sql } from 'kysely';
import { db } from './db.js';
import type { AdminContext } from './admin.js';

/** Distinguishes access records from the mutation records auditAdminAction writes. */
export const DATA_ACCESS_ACTION = 'admin:data_access';

export interface AdminDataAccess {
  admin: AdminContext;
  method: string;
  /** The route pattern, not the resolved URL — '/customers/:id', never the id. */
  route: string;
  /** The tenant whose data was returned, when it can be determined confidently. */
  customerId?: string | null;
  /** Resource identifier from the path, when the route addresses one. */
  resourceId?: string | null;
}

/**
 * Record one read of tenant data by a member of staff.
 *
 * Writes to audit_log rather than a table of its own: audit_log is
 * hash-chained and periodically signed, and access records are precisely what
 * someone covering their tracks would want to edit. Never throws — an audit
 * failure must not turn a successful read into a 500 for the operator, and the
 * gap it leaves is visible in the HIPAA-07 evidence collector.
 */
export async function recordAdminDataAccess(access: AdminDataAccess): Promise<void> {
  try {
    await db.insertInto('audit_log').values({
      customer_id: access.customerId ?? null,
      api_key_id: null,
      action: DATA_ACCESS_ACTION,
      resource: access.route,
      ip: null,
      actor_type: 'admin',
      actor_id: access.admin.admin_user_id,
      actor_label: access.admin.email,
      metadata: {
        method: access.method,
        resource_id: access.resourceId ?? null,
        admin_role: access.admin.role,
        standing_role: access.admin.standing_role,
        elevated: access.admin.elevated,
        // The field the review queue keys on. A self-granted emergency role is
        // a different event from one someone else approved.
        break_glass: access.admin.break_glass,
      },
    } as never).execute();
  } catch {
    // Deliberately swallowed — see doc comment.
  }
}

/**
 * Access that a reviewer should look at.
 *
 * Reviewing every read would mean reviewing none of them, so the default is
 * the population that actually carries risk: access taken under a break-glass
 * self-grant. Callers can widen it, but the narrow default is what makes the
 * queue something a human will keep up with.
 */
export async function listAccessForReview(opts: {
  breakGlassOnly?: boolean;
  unreviewedOnly?: boolean;
  adminUserId?: string;
  customerId?: string;
  limit?: number;
} = {}): Promise<Array<Record<string, unknown>>> {
  const breakGlassOnly = opts.breakGlassOnly ?? true;
  const unreviewedOnly = opts.unreviewedOnly ?? true;

  let q = db.selectFrom('audit_log')
    .leftJoin('admin_access_reviews', 'admin_access_reviews.audit_id', 'audit_log.id')
    .select([
      'audit_log.id as id',
      'audit_log.customer_id as customer_id',
      'audit_log.resource as route',
      'audit_log.actor_id as admin_user_id',
      'audit_log.actor_label as admin_email',
      'audit_log.metadata as metadata',
      'audit_log.occurred_at as occurred_at',
      'admin_access_reviews.decision as review_decision',
      'admin_access_reviews.reviewed_at as reviewed_at',
      'admin_access_reviews.reviewed_by as reviewed_by',
      'admin_access_reviews.note as review_note',
    ])
    .where('audit_log.action', '=', DATA_ACCESS_ACTION)
    .orderBy('audit_log.occurred_at', 'desc')
    .limit(Math.min(Math.max(1, opts.limit ?? 100), 500));

  if (breakGlassOnly) q = q.where(sql<boolean>`audit_log.metadata->>'break_glass' = 'true'`);
  if (unreviewedOnly) q = q.where('admin_access_reviews.audit_id', 'is', null);
  if (opts.adminUserId) q = q.where('audit_log.actor_id', '=', opts.adminUserId);
  if (opts.customerId) q = q.where('audit_log.customer_id', '=', opts.customerId);

  return q.execute() as unknown as Promise<Array<Record<string, unknown>>>;
}

export class AccessReviewError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'already_reviewed' | 'note_required') {
    super(message);
  }
}

/**
 * Record a reviewer's judgement about one access.
 *
 * A decision is written once and cannot be amended: the review is itself
 * evidence, and a reviewer who could quietly downgrade 'inappropriate' to
 * 'appropriate' later would make the whole record worthless. Correcting a
 * decision is a conversation, not an UPDATE.
 */
export async function reviewAdminAccess(input: {
  auditId: string | number;
  reviewedBy: string;
  decision: 'appropriate' | 'inappropriate';
  note?: string | null;
}): Promise<void> {
  const note = input.note?.trim() || null;
  if (input.decision === 'inappropriate' && !note) {
    throw new AccessReviewError('A note is required when marking access inappropriate.', 'note_required');
  }

  const target = await db.selectFrom('audit_log')
    .select('id')
    .where('id', '=', Number(input.auditId) as never)
    .where('action', '=', DATA_ACCESS_ACTION)
    .executeTakeFirst();
  if (!target) throw new AccessReviewError('No access record with that id.', 'not_found');

  const existing = await db.selectFrom('admin_access_reviews')
    .select('audit_id')
    .where('audit_id', '=', Number(input.auditId) as never)
    .executeTakeFirst();
  if (existing) throw new AccessReviewError('That access has already been reviewed.', 'already_reviewed');

  await db.insertInto('admin_access_reviews').values({
    audit_id: Number(input.auditId),
    reviewed_by: input.reviewedBy,
    decision: input.decision,
    note,
  } as never).execute();
}

export interface AccessAuditSummary {
  accesses: number;
  break_glass_accesses: number;
  break_glass_unreviewed: number;
  found_inappropriate: number;
  distinct_admins: number;
}

/** Counts over a period, for the HIPAA-07 control-evidence collector. */
export async function summarizeAccessAudit(period: { start: Date; end: Date }): Promise<AccessAuditSummary> {
  const rows = await db.selectFrom('audit_log')
    .leftJoin('admin_access_reviews', 'admin_access_reviews.audit_id', 'audit_log.id')
    .select([
      'audit_log.actor_id as actor_id',
      'admin_access_reviews.decision as decision',
      sql<boolean>`audit_log.metadata->>'break_glass' = 'true'`.as('break_glass'),
      sql<boolean>`admin_access_reviews.audit_id IS NULL`.as('unreviewed'),
    ])
    .where('audit_log.action', '=', DATA_ACCESS_ACTION)
    .where(sql<boolean>`audit_log.occurred_at BETWEEN ${period.start} AND ${period.end}`)
    .execute();

  const breakGlass = rows.filter((r) => r.break_glass);
  return {
    accesses: rows.length,
    break_glass_accesses: breakGlass.length,
    break_glass_unreviewed: breakGlass.filter((r) => r.unreviewed).length,
    found_inappropriate: rows.filter((r) => r.decision === 'inappropriate').length,
    distinct_admins: new Set(rows.map((r) => r.actor_id).filter(Boolean)).size,
  };
}
