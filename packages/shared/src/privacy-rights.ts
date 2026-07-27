// GDPR-02 / CCPA-02 (compliance implementation plan): data-subject rights
// beyond access and erasure.
//
// The platform already had the two destructive-or-read rights: export
// (Art 15 / portability) and erasure (Art 17). This module adds the three that
// were missing, each of which is a distinct legal outcome:
//
//   RESTRICTION (Art 18)   store it, do not use it. A legal hold on
//                          PROCESSING, not on deletion.
//   RECTIFICATION (Art 16, store the corrected value going forward, without
//   CCPA right to correct) falsifying the historical record.
//   OBJECTION (Art 21)     stop using it for direct marketing.
//
// The interesting one is restriction, because it is easy to mistake for
// suppression and the two must not be merged:
//
//   suppression  = "this person opted out"            (marketing state,
//                   lifted when they resubscribe)
//   restriction  = "you may store this but not use it" (legal state, lifted
//                   by a decision — accuracy verified, dispute resolved)
//
// Collapsing restriction into suppression would mean a resubscribe silently
// lifts a legal restriction, which is exactly the failure Article 18 exists to
// prevent.

import { db } from './db.js';
import type { DbExecutor } from './db.js';
import { addSuppression, appendConsentEvent, invalidateSuppressionCache } from './suppression.js';

export type RestrictionBasis =
  | 'accuracy_contested'
  | 'unlawful_processing'
  | 'legal_claims'
  | 'objection_pending';

export interface RestrictionInput {
  customerId: string;
  email: string;
  basis: RestrictionBasis;
  reason?: string | null;
  requestedBy?: string | null;
  privacyCaseId?: string | null;
}

export interface ProcessingRestriction {
  id: string;
  email: string;
  basis: RestrictionBasis;
  reason: string | null;
  requested_by: string | null;
  privacy_case_id: string | null;
  restricted_at: Date;
  released_at: Date | null;
  released_reason: string | null;
}

/**
 * Restrict processing for a recipient. Idempotent: re-restricting an already
 * restricted recipient returns the existing restriction rather than stacking
 * duplicates or resetting its start date (the original date is what the
 * statutory record needs).
 */
export async function restrictProcessing(
  input: RestrictionInput,
  executor: DbExecutor = db,
): Promise<{ restriction: ProcessingRestriction; alreadyRestricted: boolean }> {
  const email = input.email.toLowerCase();

  const existing = await executor
    .selectFrom('processing_restrictions')
    .selectAll()
    .where('customer_id', '=', input.customerId)
    .where('email', '=', email)
    .where('released_at', 'is', null)
    .executeTakeFirst();

  if (existing) {
    return { restriction: existing as unknown as ProcessingRestriction, alreadyRestricted: true };
  }

  const row = await executor
    .insertInto('processing_restrictions')
    .values({
      customer_id: input.customerId,
      email,
      basis: input.basis,
      reason: input.reason ?? null,
      requested_by: input.requestedBy ?? null,
      privacy_case_id: input.privacyCaseId ?? null,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow();

  return { restriction: row as unknown as ProcessingRestriction, alreadyRestricted: false };
}

/**
 * Lift a restriction. Requires a reason: Article 18(3) obliges the controller
 * to inform the data subject BEFORE the restriction is lifted, so an
 * unexplained release is not a defensible record.
 */
export async function releaseProcessingRestriction(
  input: { customerId: string; email: string; reason: string; releasedBy?: string | null },
  executor: DbExecutor = db,
): Promise<boolean> {
  const res = await executor
    .updateTable('processing_restrictions')
    .set({
      released_at: new Date(),
      released_reason: input.reason,
      released_by: input.releasedBy ?? null,
    } as any)
    .where('customer_id', '=', input.customerId)
    .where('email', '=', input.email.toLowerCase())
    .where('released_at', 'is', null)
    .executeTakeFirst();

  return Number(res?.numUpdatedRows ?? 0) > 0;
}

/** Send-path gate. True when this recipient must not be processed. */
export async function isProcessingRestricted(
  customerId: string,
  email: string,
  executor: DbExecutor = db,
): Promise<boolean> {
  const row = await executor
    .selectFrom('processing_restrictions')
    .select('id')
    .where('customer_id', '=', customerId)
    .where('email', '=', email.toLowerCase())
    .where('released_at', 'is', null)
    .executeTakeFirst();
  return !!row;
}

/** Batch form for the multi-recipient send path. Returns restricted addresses. */
export async function restrictedSet(
  customerId: string,
  emails: string[],
  executor: DbExecutor = db,
): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const normalized = [...new Set(emails.map((e) => e.toLowerCase()))];
  const rows = await executor
    .selectFrom('processing_restrictions')
    .select('email')
    .where('customer_id', '=', customerId)
    .where('email', 'in', normalized)
    .where('released_at', 'is', null)
    .execute();
  return new Set(rows.map((r) => r.email));
}

export async function listProcessingRestrictions(
  customerId: string,
  opts: { includeReleased?: boolean; limit?: number } = {},
): Promise<ProcessingRestriction[]> {
  let q = db
    .selectFrom('processing_restrictions')
    .selectAll()
    .where('customer_id', '=', customerId)
    .orderBy('restricted_at', 'desc')
    .limit(Math.min(Math.max(1, opts.limit ?? 100), 1000));
  if (!opts.includeReleased) q = q.where('released_at', 'is', null);
  return (await q.execute()) as unknown as ProcessingRestriction[];
}

// ─── Rectification (Art 16 / CCPA right to correct) ─────────────────────────

export interface RectificationResult {
  suppressions_moved: number;
  consent_events_moved: number;
  group_memberships_moved: number;
  restrictions_moved: number;
  /** Historical delivery records deliberately left untouched. */
  historical_messages_preserved: number;
}

/**
 * Correct a recipient's address across the forward-looking stores.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not rewrite `messages` or
 * `events`. "We sent a message to <old address> on <date>" is an ACCURATE
 * record of something that happened; rewriting it would not correct inaccurate
 * personal data, it would falsify a delivery log — and destroy the evidence
 * that CAN-SPAM, deliverability disputes, and the audit trail depend on.
 *
 * What IS corrected is every store that governs FUTURE processing: suppression
 * state, consent history, unsubscribe-group membership, and any active
 * processing restriction. That is what Article 16 is for — ensuring the
 * controller acts on the right data going forward.
 *
 * The count of preserved historical records is returned so the controller can
 * explain the distinction to the data subject rather than silently ignoring
 * part of the request.
 */
export async function rectifyRecipient(
  input: { customerId: string; from: string; to: string; requestedBy?: string | null },
  executor: DbExecutor = db,
): Promise<RectificationResult> {
  const from = input.from.toLowerCase();
  const to = input.to.toLowerCase();
  if (from === to) {
    throw new Error('rectify_noop: the corrected address is identical to the current one');
  }

  const run = async (trx: DbExecutor): Promise<RectificationResult> => {
    // Suppression is keyed (customer_id, email). If the corrected address is
    // already suppressed, drop the old row rather than colliding — the
    // stricter state (suppressed) is preserved either way.
    const targetSuppressed = await trx
      .selectFrom('suppressions').select('email')
      .where('customer_id', '=', input.customerId).where('email', '=', to)
      .executeTakeFirst();

    let suppressionsMoved = 0;
    if (targetSuppressed) {
      const del = await trx.deleteFrom('suppressions')
        .where('customer_id', '=', input.customerId).where('email', '=', from)
        .executeTakeFirst();
      suppressionsMoved = Number(del?.numDeletedRows ?? 0);
    } else {
      const upd = await trx.updateTable('suppressions').set({ email: to } as any)
        .where('customer_id', '=', input.customerId).where('email', '=', from)
        .executeTakeFirst();
      suppressionsMoved = Number(upd?.numUpdatedRows ?? 0);
    }

    const consent = await trx.updateTable('consent_events').set({ email: to } as any)
      .where('customer_id', '=', input.customerId).where('email', '=', from)
      .executeTakeFirst();

    const groups = await trx.updateTable('unsubscribe_group_members').set({ email: to } as any)
      .where('customer_id', '=', input.customerId).where('email', '=', from)
      .executeTakeFirst();

    const restrictions = await trx.updateTable('processing_restrictions').set({ email: to } as any)
      .where('customer_id', '=', input.customerId).where('email', '=', from)
      .where('released_at', 'is', null)
      .executeTakeFirst();

    const historical = await trx.selectFrom('messages')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('customer_id', '=', input.customerId).where('to_address', '=', from)
      .executeTakeFirst();

    // The correction itself is a processing act and belongs in the ledger.
    await appendConsentEvent(trx, {
      customerId: input.customerId,
      email: to,
      action: 'unsuppress',
      reason: 'manual',
      source: 'rectification',
      notes: `address corrected (rectification) by ${input.requestedBy ?? 'controller'}`,
      messageId: null,
    }).catch(() => {});

    return {
      suppressions_moved: suppressionsMoved,
      consent_events_moved: Number(consent?.numUpdatedRows ?? 0),
      group_memberships_moved: Number(groups?.numUpdatedRows ?? 0),
      restrictions_moved: Number(restrictions?.numUpdatedRows ?? 0),
      historical_messages_preserved: Number((historical as any)?.n ?? 0),
    };
  };

  const result = executor === db ? await db.transaction().execute(run) : await run(executor);

  // The suppression cache holds a verdict per (tenant, address) and caches
  // NEGATIVE results too. Moving the row without dropping both keys would
  // leave a stale '0' on the corrected address — fail-open, mail delivered to
  // someone who had opted out. Invalidate rather than rewrite: a miss just
  // costs one DB read.
  await invalidateSuppressionCache(input.customerId, from);
  await invalidateSuppressionCache(input.customerId, to);

  return result;
}

// ─── Objection (Art 21) ─────────────────────────────────────────────────────

/**
 * Record an objection to direct marketing.
 *
 * Article 21(2) gives an unconditional right to object to direct marketing —
 * there is no balancing test and no grace period, so this takes effect
 * immediately as an enforced suppression. It is recorded with its own consent
 * source so the ledger distinguishes "objected" from "clicked unsubscribe":
 * both stop the mail, but only one is a formal rights request the controller
 * may have to evidence.
 */
export async function recordObjection(
  input: { customerId: string; email: string; reason?: string | null; requestedBy?: string | null },
  executor: DbExecutor = db,
): Promise<void> {
  await addSuppression(
    input.customerId,
    input.email,
    'unsubscribe',
    input.reason ?? `Article 21 objection to direct marketing (${input.requestedBy ?? 'data subject'})`,
    executor,
    { source: 'gdpr_objection' },
  );
}
