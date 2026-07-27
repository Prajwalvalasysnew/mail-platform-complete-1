// BASE-08 (compliance implementation plan): downstream transport security.
//
// A tenant can set `tls_required` to demand encrypted delivery. Before this
// module that setting was DETECTIVE only: Haraka tagged the message, recorded
// whether the hop was actually TLS-secured, and logged an error afterwards —
// by which point the message had already been delivered in the clear.
//
// Here the evidence becomes preventive. Every delivery updates the observed
// TLS behaviour of the recipient domain; the send worker then refuses to
// deliver a TLS-required message to a domain known to accept mail without TLS.
//
// WHAT THIS DOES NOT DO. The first delivery to an unseen domain cannot be
// protected — the evidence only exists after the hop completes. This control
// bounds exposure to (at most) one message per domain; it is not guaranteed
// encrypted delivery, and it is not end-to-end encryption. PHI and equivalent
// data stay prohibited (BASE-15) until message-level encryption or secure
// portal delivery exists. See docs/TRANSPORT_SECURITY.md.

import { sql } from 'kysely';
import { db } from './db.js';

/** Extract the lowercased domain from an address. */
export function recipientDomain(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 0 || at === address.length - 1) return null;
  return address.slice(at + 1).toLowerCase();
}

/**
 * Record whether a delivery hop to this domain was TLS-secured.
 *
 * `secured === null` means the delivery agent did not report TLS state; that
 * is not evidence either way and is ignored rather than counted as plaintext.
 */
export async function recordDeliveryTlsOutcome(
  address: string,
  secured: boolean | null | undefined,
): Promise<void> {
  if (secured === null || secured === undefined) return;
  const domain = recipientDomain(address);
  if (!domain) return;

  const now = new Date();
  await db
    .insertInto('recipient_domain_tls')
    .values({
      domain,
      deliveries_secured: secured ? 1 : 0,
      deliveries_plaintext: secured ? 0 : 1,
      last_secured_at: secured ? now : null,
      last_plaintext_at: secured ? null : now,
      last_outcome_secured: secured,
    } as any)
    .onConflict((oc) => oc.column('domain').doUpdateSet({
      deliveries_secured: sql`recipient_domain_tls.deliveries_secured + ${secured ? 1 : 0}`,
      deliveries_plaintext: sql`recipient_domain_tls.deliveries_plaintext + ${secured ? 0 : 1}`,
      last_secured_at: secured ? now : sql`recipient_domain_tls.last_secured_at`,
      last_plaintext_at: secured ? sql`recipient_domain_tls.last_plaintext_at` : now,
      last_outcome_secured: secured,
      updated_at: now,
    } as any))
    .execute();
}

/**
 * How long a plaintext observation keeps a domain blocked for TLS-required
 * tenants. A domain that fixes its TLS should recover without manual action,
 * but not so fast that a flapping receiver lets messages through.
 */
function unsafeWindowMs(): number {
  return Number(process.env.TLS_UNSAFE_WINDOW_DAYS ?? 30) * 86_400_000;
}

export interface TlsDomainVerdict {
  /** True when a TLS-required message must NOT be delivered to this domain. */
  unsafe: boolean;
  /** Present when unsafe: when the plaintext delivery was observed. */
  observedAt?: Date;
}

/**
 * Decide whether a TLS-required message may go to this address.
 *
 * A domain is unsafe when a plaintext delivery was observed inside the window
 * AND it is the most recent observation. A domain that has since delivered
 * over TLS is treated as recovered — the receiver fixed its configuration, and
 * continuing to block it would be a permanent outage for that correspondent
 * with no security benefit.
 */
export async function checkDomainTlsSafety(address: string): Promise<TlsDomainVerdict> {
  const domain = recipientDomain(address);
  if (!domain) return { unsafe: false };

  const row = await db
    .selectFrom('recipient_domain_tls')
    .select(['last_plaintext_at', 'last_outcome_secured'])
    .where('domain', '=', domain)
    .executeTakeFirst();

  const plaintextAt = row?.last_plaintext_at ? new Date(row.last_plaintext_at as unknown as string) : null;
  if (!plaintextAt) return { unsafe: false };

  if (Date.now() - plaintextAt.getTime() > unsafeWindowMs()) return { unsafe: false };

  if (row?.last_outcome_secured !== false) return { unsafe: false };

  return { unsafe: true, observedAt: plaintextAt };
}

/** Operator report: domains currently blocked for TLS-required tenants. */
export async function listTlsUnsafeDomains(limit = 100): Promise<Array<{
  domain: string;
  deliveries_plaintext: number;
  last_plaintext_at: Date | null;
}>> {
  const cutoff = new Date(Date.now() - unsafeWindowMs());
  const rows = await db
    .selectFrom('recipient_domain_tls')
    .select(['domain', 'deliveries_plaintext', 'last_plaintext_at', 'last_outcome_secured'])
    .where('last_plaintext_at', 'is not', null)
    .where('last_plaintext_at', '>', cutoff as any)
    .orderBy('last_plaintext_at', 'desc')
    .limit(Math.min(Math.max(1, limit), 1000))
    .execute();

  return rows
    .filter((r) => {
      return r.last_outcome_secured === false;
    })
    .map((r) => ({
      domain: r.domain,
      deliveries_plaintext: Number(r.deliveries_plaintext ?? 0),
      last_plaintext_at: (r.last_plaintext_at as unknown as Date) ?? null,
    }));
}
