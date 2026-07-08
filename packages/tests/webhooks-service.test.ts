// DB integration tests for the org-scoped webhook service: create (with SSRF
// guard + event validation), list, partial update, secret rotation, delete,
// and strict per-org isolation. Public IP-literal URLs are used so no DNS
// lookup is needed; loopback URLs exercise the SSRF rejection path.

import { describe, expect, it } from 'vitest';
import {
  seedCustomer,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  rotateWebhookSecret,
  WebhookError,
} from '@platform/shared';

const PUB = 'https://93.184.216.34/hook'; // public IP literal — skips DNS
const PUB2 = 'https://1.1.1.1/events';

describe('createWebhook', () => {
  it('creates a webhook with a generated secret and enabled by default', async () => {
    const c = await seedCustomer();
    const wh = await createWebhook({ customerId: c.customerId, url: PUB, events: ['delivered', 'hard_bounce'] });
    expect(wh.url).toBe(PUB);
    expect(wh.events).toEqual(['delivered', 'hard_bounce']);
    expect(wh.secret).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex
    expect(wh.enabled).toBe(true);
  });

  it('rejects a URL that resolves to a private/loopback address (SSRF)', async () => {
    const c = await seedCustomer();
    await expect(createWebhook({ customerId: c.customerId, url: 'http://127.0.0.1/hook', events: ['delivered'] }))
      .rejects.toMatchObject({ code: 'invalid_webhook_url' });
  });

  it('rejects unknown event types', async () => {
    const c = await seedCustomer();
    await expect(createWebhook({ customerId: c.customerId, url: PUB, events: ['delivered', 'exploded'] }))
      .rejects.toThrow(WebhookError);
  });
});

describe('listWebhooks', () => {
  it('returns only the org\'s webhooks, newest first', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    await createWebhook({ customerId: a.customerId, url: PUB, events: ['delivered'] });
    await new Promise((r) => setTimeout(r, 5));
    const second = await createWebhook({ customerId: a.customerId, url: PUB2, events: ['opened'] });
    await createWebhook({ customerId: b.customerId, url: PUB, events: ['delivered'] });

    const aHooks = await listWebhooks(a.customerId);
    expect(aHooks).toHaveLength(2);
    expect(aHooks[0].id).toBe(second.id); // newest first
    const bHooks = await listWebhooks(b.customerId);
    expect(bHooks).toHaveLength(1);
  });
});

describe('updateWebhook', () => {
  it('toggles enabled and updates events', async () => {
    const c = await seedCustomer();
    const wh = await createWebhook({ customerId: c.customerId, url: PUB, events: ['delivered'] });
    const updated = await updateWebhook(c.customerId, wh.id, { enabled: false, events: ['opened', 'clicked'] });
    expect(updated!.enabled).toBe(false);
    expect(updated!.events).toEqual(['opened', 'clicked']);
  });

  it('re-runs the SSRF check when the url changes', async () => {
    const c = await seedCustomer();
    const wh = await createWebhook({ customerId: c.customerId, url: PUB, events: ['delivered'] });
    await expect(updateWebhook(c.customerId, wh.id, { url: 'http://169.254.169.254/' }))
      .rejects.toMatchObject({ code: 'invalid_webhook_url' });
  });

  it('returns null for a webhook not in the org', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    const wh = await createWebhook({ customerId: a.customerId, url: PUB, events: ['delivered'] });
    expect(await updateWebhook(b.customerId, wh.id, { enabled: false })).toBeNull();
  });
});

describe('rotateWebhookSecret', () => {
  it('changes the secret', async () => {
    const c = await seedCustomer();
    const wh = await createWebhook({ customerId: c.customerId, url: PUB, events: ['delivered'] });
    const rotated = await rotateWebhookSecret(c.customerId, wh.id);
    expect(rotated!.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated!.secret).not.toBe(wh.secret);
  });

  it('returns null for a cross-org webhook', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    const wh = await createWebhook({ customerId: a.customerId, url: PUB, events: ['delivered'] });
    expect(await rotateWebhookSecret(b.customerId, wh.id)).toBeNull();
  });
});

describe('deleteWebhook', () => {
  it('removes a webhook and is org-scoped', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    const wh = await createWebhook({ customerId: a.customerId, url: PUB, events: ['delivered'] });
    expect(await deleteWebhook(b.customerId, wh.id)).toBe(false); // not b's
    expect(await deleteWebhook(a.customerId, wh.id)).toBe(true);
    expect(await deleteWebhook(a.customerId, wh.id)).toBe(false); // already gone
  });
});
