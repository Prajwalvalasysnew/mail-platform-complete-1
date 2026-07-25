// CCPA-04 (opt-out of sale/sharing, Global Privacy Control) and CANSPAM-09
// (no sale or transfer of opted-out addresses).
//
// These live together because they share one enforcement point: the moment a
// list of recipient addresses is about to LEAVE the platform.
//
// Three opt-out states now exist and must stay distinct:
//   suppression  "do not email me"                    stops delivery
//   restriction  "do not process me" (GDPR Art 18)    stops processing
//   sale/share   "do not sell or share my data"       stops transfer only
//
// A recipient may legitimately keep receiving mail while refusing to be sold.
// Folding this into suppression would over-enforce (silently unsubscribing
// them) and under-record (losing the distinct legal basis).

import { db } from './db.js';
import type { DbExecutor } from './db.js';

export type SaleShareSource = 'gpc' | 'api' | 'web_form' | 'authorized_agent' | 'support';

/**
 * Detect a Global Privacy Control signal.
 *
 * CCPA §1798.135(b)(1) requires an opt-out preference signal to be treated as
 * a valid consumer request. The spec defines exactly one truthy value — the
 * header `Sec-GPC: 1` (and its DOM equivalent). Anything else, including "0",
 * "true", or absence, is NOT a signal: treating "0" as an opt-out would be as
 * wrong as ignoring "1".
 */
export function isGpcSignal(headers: Record<string, unknown> | undefined): boolean {
  if (!headers) return false;
  const raw = headers['sec-gpc'] ?? headers['Sec-GPC'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value ?? '').trim() === '1';
}

/**
 * Record an opt-out of sale/sharing. Idempotent by design: a consenting
 * browser sends GPC on EVERY request, so this must collapse to one active row
 * rather than accumulating one per click.
 */
export async function recordSaleShareOptOut(
  input: { customerId: string; email: string; source: SaleShareSource; context?: string | null },
  executor: DbExecutor = db,
): Promise<{ recorded: boolean }> {
  const email = input.email.toLowerCase();

  const existing = await executor
    .selectFrom('sale_share_optouts')
    .select('id')
    .where('customer_id', '=', input.customerId)
    .where('email', '=', email)
    .where('released_at', 'is', null)
    .executeTakeFirst();
  if (existing) return { recorded: false };

  await executor
    .insertInto('sale_share_optouts')
    .values({
      customer_id: input.customerId,
      email,
      source: input.source,
      context: input.context ?? null,
    } as any)
    .execute();
  return { recorded: true };
}

export async function hasSaleShareOptOut(
  customerId: string,
  email: string,
  executor: DbExecutor = db,
): Promise<boolean> {
  const row = await executor
    .selectFrom('sale_share_optouts')
    .select('id')
    .where('customer_id', '=', customerId)
    .where('email', '=', email.toLowerCase())
    .where('released_at', 'is', null)
    .executeTakeFirst();
  return !!row;
}

/** Addresses under an active sale/share opt-out, for export filtering. */
export async function saleShareOptOutSet(
  customerId: string,
  executor: DbExecutor = db,
): Promise<Set<string>> {
  const rows = await executor
    .selectFrom('sale_share_optouts')
    .select('email')
    .where('customer_id', '=', customerId)
    .where('released_at', 'is', null)
    .execute();
  return new Set(rows.map((r) => r.email));
}

export async function listSaleShareOptOuts(
  customerId: string,
  opts: { limit?: number } = {},
): Promise<Array<{ email: string; source: string; context: string | null; recorded_at: Date }>> {
  return (await db
    .selectFrom('sale_share_optouts')
    .select(['email', 'source', 'context', 'recorded_at'])
    .where('customer_id', '=', customerId)
    .where('released_at', 'is', null)
    .orderBy('recorded_at', 'desc')
    .limit(Math.min(Math.max(1, opts.limit ?? 100), 1000))
    .execute()) as never;
}

// ─── CANSPAM-09: transfer of opted-out addresses ────────────────────────────

/**
 * Declared purposes for exporting a suppression list.
 *
 * CAN-SPAM §5(a)(4) makes it unlawful to sell, exchange, or otherwise transfer
 * the email address of someone who has opted out — with one carve-out, a
 * transfer to a provider used to comply with the law (which is what a
 * suppression list IS for).
 *
 * The platform cannot tell from a request which of these is happening. What it
 * CAN do is require the purpose to be declared, refuse the ones that are
 * unlawful on their face, and retain the declaration — which creates the
 * accountability record and the contractual hook that the prohibition needs.
 */
export const TRANSFER_PURPOSES = {
  compliance: 'Own suppression management — honouring opt-outs when sending.',
  provider_transfer: 'Transfer to a service provider used to comply with the law (§5(a)(4) carve-out).',
  migration: 'Moving suppression state to another sending platform, to keep opt-outs honoured.',
} as const;

export type TransferPurpose = keyof typeof TRANSFER_PURPOSES;

export function isPermittedTransferPurpose(purpose: string): purpose is TransferPurpose {
  return Object.prototype.hasOwnProperty.call(TRANSFER_PURPOSES, purpose);
}

export class ProhibitedTransferError extends Error {
  readonly code = 'transfer_purpose_prohibited';
  constructor(purpose: string) {
    super(
      `Transfer purpose '${purpose}' is not permitted for a list of opted-out addresses. ` +
      `CAN-SPAM §5(a)(4) prohibits selling, exchanging, or transferring the address of a recipient ` +
      `who has opted out, except to a provider used to comply with the law. ` +
      `Permitted values: ${Object.keys(TRANSFER_PURPOSES).join(', ')}.`,
    );
  }
}

/**
 * Validate a declared transfer purpose, defaulting to own-compliance use.
 *
 * Defaulting rather than hard-requiring keeps existing integrations working:
 * an operator downloading their own suppression list to manage their own
 * sending is doing the lawful thing, and breaking that to force a parameter
 * would push people toward scraping the list endpoint instead — the same
 * transfer with no record at all.
 */
export function resolveTransferPurpose(purpose: string | undefined): TransferPurpose {
  if (purpose === undefined || purpose === '') return 'compliance';
  if (!isPermittedTransferPurpose(purpose)) throw new ProhibitedTransferError(purpose);
  return purpose;
}
