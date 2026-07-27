// SEC-04 (compliance implementation plan): regulatory retention locks.
//
// A recordkeeping rule ("retain broker-dealer communications for six years")
// cannot be expressed by either preservation mechanism the platform already
// has:
//
//   legal hold   tenant-placed and tenant-released, no end date
//   request pin  automatic, released when the access request is fulfilled
//   THIS         time-bound to a statutory period, and NOT lifted just because
//                the tenant — or the data subject — would like it gone
//
// The erasure interaction is the point. A regulatory lock must refuse a
// data-subject deletion request: GDPR Art 17(3)(b) makes compliance with a
// legal obligation a lawful ground to refuse, and a broker-dealer cannot
// delete a record it is required to keep. Refusing is correct; refusing
// silently is not, so refusals name the basis and the expiry.

import { db } from './db.js';
import type { DbExecutor } from './db.js';

export type RegulatoryBasis = 'sec_17a4' | 'finra_4511' | 'other_statutory';

export interface RegulatoryLock {
  id: string;
  customer_id: string;
  scope: string;
  basis: RegulatoryBasis;
  authority: string;
  retain_until: Date;
  created_by: string | null;
  created_at: Date;
  released_at: Date | null;
  released_reason: string | null;
}

/** Scope string for a single correspondent. Mirrors recipientHoldScope(). */
export function recipientLockScope(email: string): string {
  return `recipient:${email.toLowerCase()}`;
}

export async function placeRegulatoryLock(
  input: {
    customerId: string;
    scope: string;
    basis: RegulatoryBasis;
    authority: string;
    retainUntil: Date;
    createdBy?: string | null;
  },
  executor: DbExecutor = db,
): Promise<RegulatoryLock> {
  if (input.retainUntil.getTime() <= Date.now()) {
    throw new Error('regulatory_lock_expired: retain_until must be in the future');
  }
  const row = await executor
    .insertInto('regulatory_retention_locks')
    .values({
      customer_id: input.customerId,
      scope: input.scope,
      basis: input.basis,
      authority: input.authority,
      retain_until: input.retainUntil,
      created_by: input.createdBy ?? null,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow();
  return row as unknown as RegulatoryLock;
}

/**
 * Release a lock before its statutory expiry.
 *
 * Both a releaser and a reason are required — enforced by a table constraint
 * as well as here, because an undocumented early release of a regulatory lock
 * is precisely the act an examiner would ask about.
 */
export async function releaseRegulatoryLock(
  input: { customerId: string; lockId: string; releasedBy: string; reason: string },
  executor: DbExecutor = db,
): Promise<boolean> {
  const res = await executor
    .updateTable('regulatory_retention_locks')
    .set({
      released_at: new Date(),
      released_by: input.releasedBy,
      released_reason: input.reason,
    } as any)
    .where('id', '=', input.lockId)
    .where('customer_id', '=', input.customerId)
    .where('released_at', 'is', null)
    .executeTakeFirst();
  return Number(res?.numUpdatedRows ?? 0) > 0;
}

/**
 * Active locks covering a recipient: a tenant-wide lock or one naming them,
 * that has neither been released nor reached its retain_until.
 */
export async function activeLocksCoveringRecipient(
  customerId: string,
  email: string,
  executor: DbExecutor = db,
): Promise<RegulatoryLock[]> {
  const rows = await executor
    .selectFrom('regulatory_retention_locks')
    .selectAll()
    .where('customer_id', '=', customerId)
    .where('released_at', 'is', null)
    .where('retain_until', '>', new Date() as any)
    .where((eb: any) => eb.or([
      eb('scope', '=', 'customer'),
      eb('scope', '=', recipientLockScope(email)),
    ]))
    .execute();
  return rows as unknown as RegulatoryLock[];
}

export async function listRegulatoryLocks(
  customerId: string,
  opts: { includeReleased?: boolean } = {},
): Promise<RegulatoryLock[]> {
  let q = db
    .selectFrom('regulatory_retention_locks')
    .selectAll()
    .where('customer_id', '=', customerId)
    .orderBy('created_at', 'desc');
  if (!opts.includeReleased) q = q.where('released_at', 'is', null);
  return (await q.execute()) as unknown as RegulatoryLock[];
}

export class RegulatoryRetentionError extends Error {
  readonly code = 'regulatory_retention_active';
  constructor(public locks: RegulatoryLock[]) {
    super('records are under a regulatory retention obligation; erasure is blocked');
    this.name = 'RegulatoryRetentionError';
  }
}

/**
 * Throw if the recipient's records are under a regulatory retention
 * obligation. Call inside the erasure transaction BEFORE deleting anything.
 *
 * This refuses a request the data subject is otherwise entitled to make, so
 * the error carries the basis, the naming authority, and the expiry — the
 * controller has to be able to tell the subject WHY and UNTIL WHEN.
 */
export async function assertNoRegulatoryLock(
  customerId: string,
  email: string,
  executor: DbExecutor = db,
): Promise<void> {
  const locks = await activeLocksCoveringRecipient(customerId, email, executor);
  if (locks.length > 0) throw new RegulatoryRetentionError(locks);
}
