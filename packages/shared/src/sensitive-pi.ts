// CCPA-05 (compliance implementation plan): right to limit the use and
// disclosure of sensitive personal information (§1798.121).
//
// Message content is SPI here by definition, not by configuration:
// §1798.140(ae)(1)(E) lists "the contents of a consumer's mail, email, and
// text messages unless the business is the intended recipient", and this
// platform is never the intended recipient.
//
// WHAT THE LIMIT TURNS OFF — and, just as importantly, what it does not:
//
//   Limited      open tracking, click tracking. Whether and when someone
//                reads their mail is inference ABOUT the consumer, not
//                delivery OF the message.
//
//   Not limited  delivery/bounce/complaint handling (performing the service),
//                abuse and malware scanning (§1798.121(a) permits use to
//                prevent malicious or fraudulent activity — otherwise the
//                limit becomes an evasion technique), and the CAN-SPAM
//                footer and suppression checks (legal obligations, which a
//                consumer preference cannot switch off).
//
// This is a FORWARD-LOOKING and RETROSPECTIVE control: new messages are sent
// without tracking, and the tracker also refuses to record engagement from
// messages that were already in flight when the limit was set.

import { db } from './db.js';
import type { DbExecutor } from './db.js';

export type SensitivePiLimitSource = 'api' | 'web_form' | 'authorized_agent' | 'support' | 'privacy_case';

export interface SensitivePiLimit {
  id: string;
  email: string;
  source: SensitivePiLimitSource;
  requested_at: Date;
  released_at: Date | null;
  released_reason: string | null;
}

/** Record a request to limit use of sensitive PI. Idempotent. */
export async function limitSensitivePiUse(
  input: { customerId: string; email: string; source?: SensitivePiLimitSource },
  executor: DbExecutor = db,
): Promise<{ limit: SensitivePiLimit; alreadyLimited: boolean }> {
  const email = input.email.toLowerCase();

  const existing = await executor
    .selectFrom('sensitive_pi_limits')
    .selectAll()
    .where('customer_id', '=', input.customerId)
    .where('email', '=', email)
    .where('released_at', 'is', null)
    .executeTakeFirst();
  if (existing) return { limit: existing as unknown as SensitivePiLimit, alreadyLimited: true };

  const row = await executor
    .insertInto('sensitive_pi_limits')
    .values({ customer_id: input.customerId, email, source: input.source ?? 'api' } as any)
    .returningAll()
    .executeTakeFirstOrThrow();
  return { limit: row as unknown as SensitivePiLimit, alreadyLimited: false };
}

/**
 * Lift a limit.
 *
 * Only the consumer's own instruction should reach this. It is exposed on the
 * same tenant-scoped surface as the request itself, so the same authorization
 * that let the tenant record a limit lets them record its withdrawal — the
 * platform cannot tell the two apart, which is why the source is recorded.
 */
export async function releaseSensitivePiLimit(
  input: { customerId: string; email: string; reason?: string | null },
  executor: DbExecutor = db,
): Promise<boolean> {
  const res = await executor
    .updateTable('sensitive_pi_limits')
    .set({ released_at: new Date(), released_reason: input.reason ?? null } as any)
    .where('customer_id', '=', input.customerId)
    .where('email', '=', input.email.toLowerCase())
    .where('released_at', 'is', null)
    .executeTakeFirst();
  return Number(res?.numUpdatedRows ?? 0) > 0;
}

export async function isSensitivePiLimited(
  customerId: string,
  email: string,
  executor: DbExecutor = db,
): Promise<boolean> {
  const row = await executor
    .selectFrom('sensitive_pi_limits')
    .select('id')
    .where('customer_id', '=', customerId)
    .where('email', '=', email.toLowerCase())
    .where('released_at', 'is', null)
    .executeTakeFirst();
  return !!row;
}

/** Batch form for the multi-recipient send path. */
export async function sensitivePiLimitedSet(
  customerId: string,
  emails: string[],
  executor: DbExecutor = db,
): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const normalized = [...new Set(emails.map((e) => e.toLowerCase()))];
  const rows = await executor
    .selectFrom('sensitive_pi_limits')
    .select('email')
    .where('customer_id', '=', customerId)
    .where('email', 'in', normalized)
    .where('released_at', 'is', null)
    .execute();
  return new Set(rows.map((r) => r.email));
}

export async function listSensitivePiLimits(
  customerId: string,
  opts: { includeReleased?: boolean } = {},
): Promise<SensitivePiLimit[]> {
  let q = db
    .selectFrom('sensitive_pi_limits')
    .selectAll()
    .where('customer_id', '=', customerId)
    .orderBy('requested_at', 'desc');
  if (!opts.includeReleased) q = q.where('released_at', 'is', null);
  return (await q.execute()) as unknown as SensitivePiLimit[];
}

/**
 * Apply the limit to a message's tracking preferences.
 *
 * Forced OFF when limited, whatever the sender asked for — a consumer
 * instruction overrides a customer setting, which is the entire point of the
 * right.
 *
 * Returns the MESSAGE COLUMN NAMES, not the API's `tracking` shape, because
 * both call sites spread this straight into the messages insert. Returning
 * `{opens, clicks}` there would silently write columns that do not exist and
 * drop the real ones.
 */
export function applySensitivePiLimitToTracking(
  limited: boolean,
  requested: { opens?: boolean; clicks?: boolean } | undefined,
): { tracking_opens: boolean; tracking_clicks: boolean } {
  if (limited) return { tracking_opens: false, tracking_clicks: false };
  return {
    tracking_opens: requested?.opens ?? true,
    tracking_clicks: requested?.clicks ?? true,
  };
}
