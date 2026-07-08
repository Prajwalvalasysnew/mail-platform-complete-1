// Legal hold service (gap analysis Top-20 #19).
//
// A legal hold suspends destructive erasure for the data it covers, so a
// GDPR/CCPA erasure request cannot destroy records subject to litigation hold,
// regulatory investigation, or a retention obligation. Scopes:
//   'customer'          — the whole tenant
//   'recipient:<email>' — a single recipient (email lower-cased)

import { db } from './db.js';
import type { DbExecutor } from './db.js';

export interface LegalHold {
  id: string;
  customer_id: string;
  scope: string;
  reason: string;
  created_by: string | null;
  created_at: Date;
  released_at: Date | null;
  released_by: string | null;
}

export function recipientHoldScope(email: string): string {
  return `recipient:${email.toLowerCase()}`;
}

export interface PlaceHoldInput {
  customerId: string;
  scope: string;          // 'customer' or 'recipient:<email>'
  reason: string;
  createdBy?: string;
}

export async function placeLegalHold(input: PlaceHoldInput, executor: DbExecutor = db): Promise<LegalHold> {
  const row = await executor
    .insertInto('legal_holds')
    .values({
      customer_id: input.customerId,
      scope: input.scope,
      reason: input.reason,
      created_by: input.createdBy ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row as unknown as LegalHold;
}

/** Release (lift) an active hold. Returns false if not found or already released. */
export async function releaseLegalHold(customerId: string, id: string, releasedBy?: string, executor: DbExecutor = db): Promise<boolean> {
  const res = await executor
    .updateTable('legal_holds')
    .set({ released_at: new Date(), released_by: releasedBy ?? null })
    .where('id', '=', id)
    .where('customer_id', '=', customerId)
    .where('released_at', 'is', null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0) > 0;
}

export async function listLegalHolds(customerId: string, opts: { activeOnly?: boolean } = {}, executor: DbExecutor = db): Promise<LegalHold[]> {
  let q = executor
    .selectFrom('legal_holds')
    .selectAll()
    .where('customer_id', '=', customerId)
    .orderBy('created_at', 'desc');
  if (opts.activeOnly) q = q.where('released_at', 'is', null);
  const rows = await q.execute();
  return rows as unknown as LegalHold[];
}

/**
 * Return the active holds (if any) that cover a given recipient under a
 * customer — either a tenant-wide 'customer' hold or a matching
 * 'recipient:<email>' hold. Empty array = erasure is permitted.
 */
export async function activeHoldsCoveringRecipient(customerId: string, email: string, executor: DbExecutor = db): Promise<LegalHold[]> {
  const rows = await executor
    .selectFrom('legal_holds')
    .selectAll()
    .where('customer_id', '=', customerId)
    .where('released_at', 'is', null)
    .where((eb: any) => eb.or([
      eb('scope', '=', 'customer'),
      eb('scope', '=', recipientHoldScope(email)),
    ]))
    .execute();
  return rows as unknown as LegalHold[];
}

/** True if any active hold covers the recipient (erasure must be blocked). */
export async function isRecipientUnderHold(customerId: string, email: string, executor: DbExecutor = db): Promise<boolean> {
  const holds = await activeHoldsCoveringRecipient(customerId, email, executor);
  return holds.length > 0;
}

export class LegalHoldError extends Error {
  constructor(public holds: LegalHold[]) {
    super('recipient is under an active legal hold; erasure is blocked');
    this.name = 'LegalHoldError';
  }
}

/**
 * Throw LegalHoldError if the recipient is under an active hold. Call inside the
 * erasure transaction BEFORE deleting anything, so a held recipient's data is
 * never destroyed.
 */
export async function assertNoActiveHold(customerId: string, email: string, executor: DbExecutor = db): Promise<void> {
  const holds = await activeHoldsCoveringRecipient(customerId, email, executor);
  if (holds.length > 0) throw new LegalHoldError(holds);
}
