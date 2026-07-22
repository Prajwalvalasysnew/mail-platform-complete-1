// Persona E2E: a free developer completes the first-value lifecycle.
//
// This is intentionally journey-oriented rather than endpoint-oriented:
// signup -> authenticate -> compliance profile -> verification gate -> domain
// readiness -> real queue/worker delivery -> events/usage -> free quota limit.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@platform/shared';
import {
  getEventTypes,
  getUsageSent,
  resetPoolWarmup,
  resetQuota,
  seedVerifiedDomain,
  startHarness,
  waitForStatus,
  type Harness,
} from '../harness.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
  await resetPoolWarmup('transactional');
});

afterAll(async () => {
  await h.close();
});

function auth(apiKey: string) {
  return { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
}

describe('persona: free developer', () => {
  it('reaches first delivery and is protected by the free-tier quota', async () => {
    const email = `persona-free-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

    // 1. Self-serve signup gives the developer a live API key, but sending is
    // still gated until they prove email ownership.
    const signup = await h.app.inject({
      method: 'POST',
      url: '/v1/signup',
      headers: { 'content-type': 'application/json' },
      payload: { email, name: 'Free Developer Persona' },
    });
    expect(signup.statusCode).toBe(201);

    const signupBody = signup.json();
    const customerId = signupBody.customer.id as string;
    const apiKey = signupBody.api_key as string;
    const verificationToken = signupBody._dev_email_verify_token as string;
    expect(apiKey).toMatch(/^mp_live_/);
    expect(verificationToken).toBeTruthy();

    // 2. The key authenticates immediately for setup/account operations and
    // exposes the actual plan limits assigned by signup.
    const profile = await h.app.inject({ method: 'GET', url: '/v1/profile', headers: auth(apiKey) });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().customer).toMatchObject({
      id: customerId,
      email,
      tier: 'free',
      daily_quota: 100,
      monthly_quota: 3000,
    });

    // 3. A real live sender must provide the CAN-SPAM physical address.
    const profileUpdate = await h.app.inject({
      method: 'PATCH',
      url: '/v1/profile',
      headers: auth(apiKey),
      payload: { physical_address: '123 Developer Lane, Test City, CA 94105' },
    });
    expect(profileUpdate.statusCode).toBe(200);

    // DNS itself is external and nondeterministic in CI. This helper models a
    // successfully completed DNS verification, after the API portion of the
    // onboarding journey has been exercised normally.
    const domain = await seedVerifiedDomain(customerId, 'free-persona.example.com');

    const message = {
      from: `noreply@${domain}`,
      to: 'first-user@example.net',
      subject: 'Your first transactional email',
      html: '<p>Welcome! Your integration works.</p>',
      tags: ['persona', 'transactional', 'welcome'],
    };

    const blockedBeforeVerification = await h.app.inject({
      method: 'POST', url: '/v1/send', headers: auth(apiKey), payload: message,
    });
    expect(blockedBeforeVerification.statusCode).toBe(403);
    expect(blockedBeforeVerification.json().error).toBe('email_not_verified');

    // 4. Consume the same verification token a user receives by email.
    const verify = await h.app.inject({
      method: 'POST',
      url: '/v1/verify-email',
      headers: { 'content-type': 'application/json' },
      payload: { token: verificationToken },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().ok).toBe(true);

    await resetQuota(customerId);

    // 5. Send through the real API -> Postgres -> BullMQ -> send worker path.
    const sent = await h.app.inject({ method: 'POST', url: '/v1/send', headers: auth(apiKey), payload: message });
    expect(sent.statusCode).toBe(202);
    expect(sent.json().accepted).toBe(1);
    expect(sent.json().message_ids).toHaveLength(1);

    const messageId = sent.json().message_ids[0] as string;
    const finalStatus = await waitForStatus(messageId, ['accepted', 'sent']);
    expect(['accepted', 'sent']).toContain(finalStatus);
    expect(await getUsageSent(customerId)).toBe(1);
    expect(await getEventTypes(messageId)).toEqual(expect.arrayContaining(['queued', 'sent']));

    // 6. One unit is already consumed. A 100-recipient request would make the
    // daily total 101, so the free plan must reject it atomically.
    const quotaExceeded = await h.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: auth(apiKey),
      payload: {
        ...message,
        to: Array.from({ length: 100 }, (_, i) => `quota-${i}@example.net`),
        subject: 'This request exceeds the free daily quota',
      },
    });
    expect(quotaExceeded.statusCode).toBe(429);
    expect(quotaExceeded.json().error).toBe('quota_exceeded');
    expect(quotaExceeded.json().daily.limit).toBe(100);

    // The rejected request must not change persisted usage.
    expect(await getUsageSent(customerId)).toBe(1);
    const stored = await db.selectFrom('customers')
      .select(['tier', 'email_verified_at', 'physical_address'])
      .where('id', '=', customerId)
      .executeTakeFirstOrThrow();
    expect(stored.tier).toBe('free');
    expect(stored.email_verified_at).toBeTruthy();
    expect(stored.physical_address).toContain('Developer Lane');
  });
});
