// E2E: API-first customer email verification flow.
//
// Covers POST /v1/signup (token issuance), POST /v1/verify-email (token
// consumption), POST /v1/resend-verification (enumeration protection), and the
// send gate that blocks live-key delivery until the email is verified.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain } from './harness.js';
import { db } from '@platform/shared';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

function uniqueEmail(): string {
  return `evtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function signup(email: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/signup',
    headers: { 'content-type': 'application/json' },
    payload: { email, name: 'Test Customer' },
  });
}

// ---------------------------------------------------------------------------
// POST /v1/verify-email
// ---------------------------------------------------------------------------

describe('POST /v1/verify-email', () => {
  it('verifies a customer email with a valid token and stamps email_verified_at', async () => {
    const email = uniqueEmail();
    const signupRes = await signup(email);
    expect(signupRes.statusCode).toBe(201);
    const { _dev_email_verify_token: token, customer } = signupRes.json();
    expect(token).toBeTruthy(); // present in non-production envs

    const res = await app.inject({
      method: 'POST',
      url: '/v1/verify-email',
      headers: { 'content-type': 'application/json' },
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    const row = await db
      .selectFrom('customers')
      .select('email_verified_at')
      .where('id', '=', customer.id)
      .executeTakeFirst();
    expect(row?.email_verified_at).toBeTruthy();
  });

  it('returns 400 invalid_or_expired_token for a bogus token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/verify-email',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'totally-bogus-token-that-does-not-exist' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_or_expired_token');
  });

  it('returns 400 token_expired for a token whose expiry has passed', async () => {
    const email = uniqueEmail();
    const signupRes = await signup(email);
    expect(signupRes.statusCode).toBe(201);
    const { _dev_email_verify_token: token, customer } = signupRes.json();

    // Backdate the expiry so the token is already stale.
    await db
      .updateTable('customers')
      .set({ email_verify_token_expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', customer.id)
      .execute();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/verify-email',
      headers: { 'content-type': 'application/json' },
      payload: { token },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('token_expired');
  });

  it('is idempotent: re-verifying with the same token returns invalid (token consumed)', async () => {
    const email = uniqueEmail();
    const signupRes = await signup(email);
    const { _dev_email_verify_token: token } = signupRes.json();

    await app.inject({
      method: 'POST',
      url: '/v1/verify-email',
      headers: { 'content-type': 'application/json' },
      payload: { token },
    });

    // Second attempt: token hash was cleared on first success.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/verify-email',
      headers: { 'content-type': 'application/json' },
      payload: { token },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_or_expired_token');
  });
});

// ---------------------------------------------------------------------------
// POST /v1/resend-verification
// ---------------------------------------------------------------------------

describe('POST /v1/resend-verification', () => {
  it('returns 200 for an unknown email without leaking whether the account exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resend-verification',
      headers: { 'content-type': 'application/json' },
      payload: { email: uniqueEmail() }, // account does not exist
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json()._dev_email_verify_token).toBeUndefined();
  });

  it('returns 200 silently for an already-verified customer (no new token)', async () => {
    const email = uniqueEmail();
    const signupRes = await signup(email);
    const { _dev_email_verify_token: token } = signupRes.json();

    // Verify first.
    await app.inject({
      method: 'POST',
      url: '/v1/verify-email',
      headers: { 'content-type': 'application/json' },
      payload: { token },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resend-verification',
      headers: { 'content-type': 'application/json' },
      payload: { email },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    // No new token for an already-verified account — same silent 200 as unknown email.
    expect(res.json()._dev_email_verify_token).toBeUndefined();
  });

  it('issues a fresh token for an unverified customer', async () => {
    const email = uniqueEmail();
    await signup(email);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resend-verification',
      headers: { 'content-type': 'application/json' },
      payload: { email },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json()._dev_email_verify_token).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Send gate: email verification requirement
// ---------------------------------------------------------------------------

describe('POST /v1/send: email verification gate', () => {
  it('blocks delivery from a live (secret) key whose account is unverified → 403', async () => {
    // seedCustomer defaults to email_verified_at = NULL (not set during insert).
    const cust = await seedCustomer({ keyType: 'secret' });
    const domain = await seedVerifiedDomain(cust.customerId);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { to: 'recipient@example.com', from: `noreply@${domain}`, subject: 'hi', text: 'hello' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('email_not_verified');
  });

  it('allows delivery from a test key even with unverified email → 202', async () => {
    // Test keys always set test_mode=true; the verification gate is skipped.
    const cust = await seedCustomer({ keyType: 'test' });
    const domain = await seedVerifiedDomain(cust.customerId);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { to: 'recipient@example.com', from: `noreply@${domain}`, subject: 'hi', text: 'hello' },
    });
    expect(res.statusCode).toBe(202);
  });
});
