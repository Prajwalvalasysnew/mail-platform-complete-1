// BASE-03 (compliance implementation plan): keyed pseudonymization of erased
// recipient identifiers.
//
// GDPR/CCPA erasure must not leave the recipient's plaintext email behind in
// the consent ledger, the erasure evidence record, or unsubscribe-group
// membership — but the platform still needs retention-bounded PROOF that an
// opt-out existed and that an erasure was performed. The compromise is a keyed
// HMAC pseudonym: with the key and a candidate email the pseudonym is
// recomputable (so evidence stays verifiable), but the stored value alone
// cannot be reversed into the identifier.
import crypto from 'node:crypto';
import type { DbExecutor } from './db.js';

export const ERASED_PSEUDONYM_PREFIX = 'erased:';

function pseudonymSecret(): string {
  // Prefer a dedicated key so privacy evidence can be rotated/destroyed
  // independently; fall back to ENCRYPTION_KEY (already required in
  // production by the config guard) so existing deployments keep working.
  const s = process.env.PRIVACY_PSEUDONYM_SECRET || process.env.ENCRYPTION_KEY;
  if (!s || s.length < 16) {
    throw new Error('PRIVACY_PSEUDONYM_SECRET or ENCRYPTION_KEY (>= 16 chars) is required for erasure pseudonymization');
  }
  return s;
}

/**
 * Deterministic keyed pseudonym for an erased recipient, scoped per tenant so
 * the same address held by two customers yields unlinkable values.
 * Format: erased:<32 hex chars> — short enough for every email column.
 */
export function erasedRecipientPseudonym(customerId: string, email: string): string {
  const mac = crypto
    .createHmac('sha256', pseudonymSecret())
    .update(`${customerId}\n${email.toLowerCase()}`)
    .digest('hex')
    .slice(0, 32);
  return `${ERASED_PSEUDONYM_PREFIX}${mac}`;
}

export function isErasedPseudonym(value: string): boolean {
  return value.startsWith(ERASED_PSEUDONYM_PREFIX);
}

export interface RecipientPseudonymizationResult {
  pseudonym: string;
  consentEventsPseudonymized: number;
  deletionRequestsPseudonymized: number;
  groupMembershipsDeleted: number;
  /** GDPR-05 consent grant records scrubbed of direct identifiers. */
  consentRecordsPseudonymized: number;
}

/**
 * Remove the recipient's direct identifiers from the stores that survive
 * erasure. Must run inside the erasure transaction, AFTER every step that
 * appends plaintext ledger rows (e.g. removeSuppression), so the rows those
 * steps create are pseudonymized too.
 *
 * - consent_events: email replaced with the pseudonym; free-text notes are
 *   cleared (they may quote the address). Action/reason/source/timestamps —
 *   the actual opt-out proof — are retained.
 * - deletion_requests: prior requests for this recipient get the pseudonym
 *   (the current request should be INSERTED with the pseudonym directly, so
 *   the erasure never writes the plaintext identifier at all).
 * - unsubscribe_group_members: rows deleted; the group opt-out history
 *   survives pseudonymously in consent_events.
 */
export async function pseudonymizeErasedRecipient(
  customerId: string,
  email: string,
  executor: DbExecutor
): Promise<RecipientPseudonymizationResult> {
  const normalized = email.toLowerCase();
  const pseudonym = erasedRecipientPseudonym(customerId, normalized);
  const now = new Date();

  const consent = await executor
    .updateTable('consent_events')
    .set({ email: pseudonym, notes: null, pseudonymized_at: now })
    .where('customer_id', '=', customerId)
    .where('email', '=', normalized)
    .executeTakeFirst();

  const requests = await executor
    .updateTable('deletion_requests')
    .set({ recipient: pseudonym, pseudonymized_at: now })
    .where('customer_id', '=', customerId)
    .where('recipient', '=', normalized)
    .executeTakeFirst();

  const members = await executor
    .deleteFrom('unsubscribe_group_members')
    .where('customer_id', '=', customerId)
    .where('email', '=', normalized)
    .executeTakeFirst();

  // GDPR-05 consent grants. The row survives — the controller must still be
  // able to account for mail sent while consent was valid — but everything
  // that identifies the person goes: the address becomes the pseudonym, and
  // the IP, user agent and confirmation token are cleared outright, since they
  // are personal data with no evidential value once the subject is erased.
  // What remains (method, evidence wording, policy version, timestamps) is the
  // proof itself and carries no identifier.
  const consentGrants = await executor
    .updateTable('consent_records')
    .set({
      email: pseudonym,
      ip: null,
      user_agent: null,
      confirmation_token: null,
      pseudonymized_at: now,
    } as any)
    .where('customer_id', '=', customerId)
    .where('email', '=', normalized)
    .executeTakeFirst();

  return {
    pseudonym,
    consentEventsPseudonymized: Number(consent.numUpdatedRows ?? 0),
    deletionRequestsPseudonymized: Number(requests.numUpdatedRows ?? 0),
    groupMembershipsDeleted: Number(members.numDeletedRows ?? 0),
    consentRecordsPseudonymized: Number(consentGrants.numUpdatedRows ?? 0),
  };
}
