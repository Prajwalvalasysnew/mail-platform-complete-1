// GDPR-05 (compliance implementation plan): consent standards.
//
// consent_events already proved someone OPTED OUT. This proves they OPTED IN,
// which is what Art 7(1) actually demands — "the controller shall be able to
// demonstrate that the data subject has consented". An opt-out ledger with no
// matching opt-in record answers the wrong question.
//
// The two ledgers are complementary and both are needed for a defensible
// position:
//
//   consent_records  the grant: when, how, under which notice, shown what
//   consent_events   the enforcement history: every suppress/unsuppress
//
// Withdrawal (Art 7(3)) must be as easy as granting, and it must NOT delete
// the proof that consent once existed — the controller still has to account
// for mail sent while it was valid. So withdrawal marks the record, it does
// not remove it.

import crypto from 'node:crypto';
import { db } from './db.js';
import type { DbExecutor } from './db.js';

export type ConsentMethod = 'web_form' | 'double_opt_in' | 'api' | 'offline' | 'import_with_evidence';

export interface ConsentGrantInput {
  customerId: string;
  email: string;
  purpose?: string;
  method: ConsentMethod;
  /** The exact wording the subject agreed to. Required — see below. */
  evidenceText: string;
  policyVersion?: string | null;
  sourceUrl?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface ConsentRecord {
  id: string;
  email: string;
  purpose: string;
  method: ConsentMethod;
  evidence_text: string;
  policy_version: string | null;
  source_url: string | null;
  ip: string | null;
  user_agent: string | null;
  granted_at: Date;
  confirmation_token: string | null;
  confirmed_at: Date | null;
  withdrawn_at: Date | null;
  withdrawal_source: string | null;
}

export class ConsentEvidenceError extends Error {
  readonly code = 'consent_evidence_required';
}

/**
 * Record an affirmative grant of consent.
 *
 * `evidenceText` is mandatory and non-trivial by design. "They consented" is
 * not evidence; "they were shown THIS wording and clicked agree" is. A record
 * without it would look like proof while proving nothing, which is worse than
 * having no record at all — it invites relying on it.
 *
 * Re-consenting supersedes: the previous live grant is withdrawn first, so the
 * unique index holds and the history reads as a chain rather than a set of
 * competing claims.
 */
export async function recordConsentGrant(
  input: ConsentGrantInput,
  executor: DbExecutor = db,
): Promise<{ record: ConsentRecord; confirmationToken: string | null }> {
  const evidence = input.evidenceText?.trim() ?? '';
  if (evidence.length < 10) {
    throw new ConsentEvidenceError(
      'evidence_text must record the exact wording the data subject agreed to (at least 10 characters). ' +
      'Article 7(1) requires demonstrating consent, which a bare assertion does not.',
    );
  }

  const email = input.email.toLowerCase();
  const purpose = input.purpose ?? 'marketing';

  // Double opt-in issues a token now and is only VALID once confirmed.
  const confirmationToken = input.method === 'double_opt_in'
    ? crypto.randomBytes(24).toString('base64url')
    : null;

  const run = async (trx: DbExecutor) => {
    await trx.updateTable('consent_records')
      .set({ withdrawn_at: new Date(), withdrawal_source: 'superseded_by_new_consent' } as any)
      .where('customer_id', '=', input.customerId)
      .where('email', '=', email)
      .where('purpose', '=', purpose)
      .where('withdrawn_at', 'is', null)
      .execute();

    return trx.insertInto('consent_records').values({
      customer_id: input.customerId,
      email,
      purpose,
      method: input.method,
      evidence_text: evidence,
      policy_version: input.policyVersion ?? null,
      source_url: input.sourceUrl ?? null,
      ip: input.ip ?? null,
      user_agent: input.userAgent ?? null,
      confirmation_token: confirmationToken,
    } as any).returningAll().executeTakeFirstOrThrow();
  };

  const record = executor === db ? await db.transaction().execute(run) : await run(executor);
  return { record: record as unknown as ConsentRecord, confirmationToken };
}

/** Complete a double opt-in. Returns false for an unknown or spent token. */
export async function confirmDoubleOptIn(
  token: string,
  executor: DbExecutor = db,
): Promise<boolean> {
  const res = await executor
    .updateTable('consent_records')
    .set({ confirmed_at: new Date() } as any)
    .where('confirmation_token', '=', token)
    .where('confirmed_at', 'is', null)
    .where('withdrawn_at', 'is', null)
    .executeTakeFirst();
  return Number(res?.numUpdatedRows ?? 0) > 0;
}

/**
 * Is there consent the controller could actually rely on right now?
 *
 * A double opt-in that was never confirmed does NOT count. Treating an
 * unconfirmed record as consent would mean anyone could subscribe any address
 * — the exact abuse double opt-in exists to prevent.
 */
export async function hasValidConsent(
  customerId: string,
  email: string,
  purpose = 'marketing',
  executor: DbExecutor = db,
): Promise<boolean> {
  const row = await executor
    .selectFrom('consent_records')
    .select(['method', 'confirmed_at'])
    .where('customer_id', '=', customerId)
    .where('email', '=', email.toLowerCase())
    .where('purpose', '=', purpose)
    .where('withdrawn_at', 'is', null)
    .executeTakeFirst();
  if (!row) return false;
  if (row.method === 'double_opt_in' && !row.confirmed_at) return false;
  return true;
}

/**
 * Withdraw consent. Art 7(3): as easy as giving it, and not retroactive — the
 * record is marked, never deleted, because mail sent while consent was valid
 * still has to be accountable.
 */
export async function withdrawConsent(
  input: { customerId: string; email: string; purpose?: string; source?: string | null },
  executor: DbExecutor = db,
): Promise<boolean> {
  const res = await executor
    .updateTable('consent_records')
    .set({ withdrawn_at: new Date(), withdrawal_source: input.source ?? 'api' } as any)
    .where('customer_id', '=', input.customerId)
    .where('email', '=', input.email.toLowerCase())
    .where('purpose', '=', input.purpose ?? 'marketing')
    .where('withdrawn_at', 'is', null)
    .executeTakeFirst();
  return Number(res?.numUpdatedRows ?? 0) > 0;
}

export interface ConsentProof {
  email: string;
  has_valid_consent: boolean;
  records: ConsentRecord[];
}

/**
 * Everything needed to demonstrate consent for one address: the full grant
 * chain including superseded and withdrawn records, newest first.
 *
 * Returns the history rather than only the live grant — an accountability
 * question is usually "what was the position on <date>", which a single
 * current row cannot answer.
 */
export async function getConsentProof(
  customerId: string,
  email: string,
  executor: DbExecutor = db,
): Promise<ConsentProof> {
  const normalized = email.toLowerCase();
  const records = await executor
    .selectFrom('consent_records')
    .selectAll()
    .where('customer_id', '=', customerId)
    .where('email', '=', normalized)
    .orderBy('granted_at', 'desc')
    .execute();

  return {
    email: normalized,
    has_valid_consent: await hasValidConsent(customerId, normalized, 'marketing', executor),
    records: records as unknown as ConsentRecord[],
  };
}
