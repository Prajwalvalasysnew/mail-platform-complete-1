// Webhook endpoint management, org-scoped. Shared by the API-key route
// (requireScope('webhooks')) and the dashboard route (requireCapability(
// 'settings:manage')) so the two never diverge. Every query filters by
// customer_id, so one org can never see or mutate another's webhooks.

import { randomBytes } from 'node:crypto';
import { db } from './db.js';
import { withTenant } from './tenant-context.js';
import { resolveAndAssertPublicUrl, SsrfError } from './ssrf.js';

export const WEBHOOK_EVENT_TYPES = [
  'delivered', 'soft_bounce', 'hard_bounce', 'complaint', 'opened', 'clicked', 'unsubscribed', 'failed',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookRecord {
  id: string;
  url: string;
  events: string[];
  secret: string;
  /**
   * Still-valid old secret during the rotation grace window (null once
   * expired/cleared). Customers should verify against BOTH `secret` and
   * `previous_secret` (when present) until `previous_secret_expires_at`.
   */
  previous_secret: string | null;
  previous_secret_expires_at: Date | null;
  enabled: boolean;
  created_at: Date;
}

export class WebhookError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = 'WebhookError';
  }
}

const WEBHOOK_COLS = ['id', 'url', 'events', 'secret', 'previous_secret', 'previous_secret_expires_at', 'enabled', 'created_at'] as const;

function validateEvents(events: string[]): void {
  if (events.length === 0) throw new WebhookError('no_events', 'At least one event type is required.');
  const allowed = new Set<string>(WEBHOOK_EVENT_TYPES);
  const bad = events.filter((e) => !allowed.has(e));
  if (bad.length > 0) throw new WebhookError('invalid_event', `Unknown event type(s): ${bad.join(', ')}`);
}

// Reject URLs that resolve to private/internal/loopback addresses (SSRF). This
// is also enforced at delivery time; checking here gives immediate feedback.
async function assertSafeUrl(url: string): Promise<void> {
  try {
    await resolveAndAssertPublicUrl(url);
  } catch (err) {
    if (err instanceof SsrfError) throw new WebhookError('invalid_webhook_url', err.message);
    throw err;
  }
}

export async function listWebhooks(customerId: string): Promise<WebhookRecord[]> {
  const rows = await withTenant(customerId, (trx) =>
    trx
      .selectFrom('webhooks')
      .select([...WEBHOOK_COLS])
      .where('customer_id', '=', customerId)
      .orderBy('created_at', 'desc')
      .execute()
  );
  return rows as unknown as WebhookRecord[];
}

export async function createWebhook(input: {
  customerId: string;
  url: string;
  events: string[];
}): Promise<WebhookRecord> {
  validateEvents(input.events);
  // Network I/O (DNS resolution for the SSRF check) — done before opening any
  // transaction, same reasoning as domains.ts's DNS verification.
  await assertSafeUrl(input.url);
  const row = await withTenant(input.customerId, (trx) =>
    trx
      .insertInto('webhooks')
      .values({ customer_id: input.customerId, url: input.url, events: input.events })
      .returning([...WEBHOOK_COLS])
      .executeTakeFirstOrThrow()
  );
  return row as unknown as WebhookRecord;
}

/** Partial update of a webhook (url / events / enabled), org-scoped. */
export async function updateWebhook(
  customerId: string,
  id: string,
  patch: { url?: string; events?: string[]; enabled?: boolean }
): Promise<WebhookRecord | null> {
  const existing = await withTenant(customerId, (trx) =>
    trx
      .selectFrom('webhooks')
      .select(['id'])
      .where('id', '=', id)
      .where('customer_id', '=', customerId)
      .executeTakeFirst()
  );
  if (!existing) return null;

  const set: Record<string, unknown> = {};
  if (patch.events !== undefined) {
    validateEvents(patch.events);
    set.events = patch.events;
  }
  if (patch.url !== undefined) {
    // Network I/O (DNS resolution) — done outside any transaction, between
    // the existence check above and the write below.
    await assertSafeUrl(patch.url);
    set.url = patch.url;
  }
  if (patch.enabled !== undefined) set.enabled = patch.enabled;

  if (Object.keys(set).length === 0) {
    // Nothing to change — return the current record.
    const row = await withTenant(customerId, (trx) =>
      trx.selectFrom('webhooks').select([...WEBHOOK_COLS]).where('id', '=', id).where('customer_id', '=', customerId).executeTakeFirst()
    );
    return (row ?? null) as unknown as WebhookRecord | null;
  }

  const row = await withTenant(customerId, (trx) =>
    trx
      .updateTable('webhooks')
      .set(set)
      .where('id', '=', id)
      .where('customer_id', '=', customerId)
      .returning([...WEBHOOK_COLS])
      .executeTakeFirst()
  );
  return (row ?? null) as unknown as WebhookRecord | null;
}

/** Delete a webhook, org-scoped. Returns true if a row was removed. */
export async function deleteWebhook(customerId: string, id: string): Promise<boolean> {
  const res = await withTenant(customerId, (trx) =>
    trx
      .deleteFrom('webhooks')
      .where('id', '=', id)
      .where('customer_id', '=', customerId)
      .executeTakeFirst()
  );
  return Number(res.numDeletedRows ?? 0) > 0;
}

/**
 * Rotate a webhook's signing secret (e.g. after a suspected leak). Returns the
 * updated record with the new secret, or null if the webhook isn't in the org.
 */
const WEBHOOK_SECRET_ROTATION_GRACE_HOURS = Number(process.env.WEBHOOK_SECRET_ROTATION_GRACE_HOURS ?? 24);

export async function rotateWebhookSecret(customerId: string, id: string): Promise<WebhookRecord | null> {
  const newSecret = randomBytes(32).toString('hex');
  // Move the CURRENT secret into previous_secret with a grace-period expiry,
  // instead of discarding it. Outbound deliveries always sign with the new
  // `secret`, but the customer's verifier can accept either `secret` or
  // `previous_secret` until it expires — closing the window where deliveries
  // sent right after rotation fail verification because the customer hasn't
  // redeployed their handler yet.
  const existing = await withTenant(customerId, (trx) =>
    trx
      .selectFrom('webhooks')
      .select(['secret'])
      .where('id', '=', id)
      .where('customer_id', '=', customerId)
      .executeTakeFirst()
  );
  if (!existing) return null;

  const graceExpiry = new Date(Date.now() + WEBHOOK_SECRET_ROTATION_GRACE_HOURS * 3600_000);
  const row = await withTenant(customerId, (trx) =>
    trx
      .updateTable('webhooks')
      .set({
        secret: newSecret,
        previous_secret: existing.secret,
        previous_secret_expires_at: graceExpiry,
      })
      .where('id', '=', id)
      .where('customer_id', '=', customerId)
      .returning([...WEBHOOK_COLS])
      .executeTakeFirst()
  );
  return (row ?? null) as unknown as WebhookRecord | null;
}

/**
 * Clear previous_secret/previous_secret_expires_at for webhooks whose grace
 * window has elapsed. Intended for the scheduler; returns rows cleared.
 */
export async function clearExpiredWebhookRotationSecrets(): Promise<number> {
  const res = await db
    .updateTable('webhooks')
    .set({ previous_secret: null, previous_secret_expires_at: null })
    .where('previous_secret', 'is not', null)
    .where('previous_secret_expires_at', '<', new Date())
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}
