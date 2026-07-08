// Regression tests for production-hardening fixes:
//   1. Billing webhook verifiers fail CLOSED in production when the signing
//      secret is unset (previously `if (!secret) return true` — accepting any
//      forged payload).
//   2. config-guard conditionally requires the active provider's webhook secret
//      in production.
//   3. metricsAuthorized gates the Prometheus /metrics endpoint.
//
// These are pure-function tests (no DB/Redis), so they run anywhere.

import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import {
  verifyStripeSignature,
  verifyPayPalSignature,
  verifyCashfreeSignature,
} from '@platform/api/routes/billing.js';
import { checkConfig, metricsAuthorized } from '@platform/shared';

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  // Restore env between cases so NODE_ENV / secrets don't leak across tests.
  for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
});

// ─── 1. Webhook verifiers fail closed in production ──────────────────────────
describe('billing webhook verifiers — missing secret', () => {
  it('Stripe: allows unsigned outside production (dev convenience)', () => {
    process.env.NODE_ENV = 'development';
    expect(verifyStripeSignature('{}', undefined, undefined)).toBe(true);
  });

  it('Stripe: REJECTS unsigned in production (no secret configured)', () => {
    process.env.NODE_ENV = 'production';
    expect(verifyStripeSignature('{}', undefined, undefined)).toBe(false);
  });

  it('PayPal: REJECTS unsigned in production', () => {
    process.env.NODE_ENV = 'production';
    expect(verifyPayPalSignature({ payload: '{}' })).toBe(false);
  });

  it('Cashfree: REJECTS unsigned in production', () => {
    process.env.NODE_ENV = 'production';
    expect(verifyCashfreeSignature({ payload: '{}' })).toBe(false);
  });
});

describe('billing webhook verifiers — with secret (still verify correctly)', () => {
  it('Stripe: accepts a correctly-signed recent payload and rejects a forged one', () => {
    process.env.NODE_ENV = 'production';
    const secret = 'whsec_'.padEnd(24, 'x');
    const payload = JSON.stringify({ type: 'invoice.paid' });
    const t = Math.floor(Date.now() / 1000);
    const good = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
    expect(verifyStripeSignature(payload, `t=${t},v1=${good}`, secret)).toBe(true);
    // Forged signature is rejected.
    expect(verifyStripeSignature(payload, `t=${t},v1=${'0'.repeat(64)}`, secret)).toBe(false);
  });

  it('Stripe: rejects a stale timestamp (replay protection) even with valid HMAC', () => {
    process.env.NODE_ENV = 'production';
    const secret = 'whsec_'.padEnd(24, 'x');
    const payload = JSON.stringify({ type: 'invoice.paid' });
    const t = Math.floor(Date.now() / 1000) - 10_000; // way outside the 300s window
    const sig = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
    expect(verifyStripeSignature(payload, `t=${t},v1=${sig}`, secret)).toBe(false);
  });

  it('Cashfree: accepts a correctly-signed payload', () => {
    process.env.NODE_ENV = 'production';
    const secret = 'cfsecret'.padEnd(20, 'z');
    const payload = JSON.stringify({ data: 1 });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac('sha256', secret).update(timestamp + payload).digest('base64');
    expect(verifyCashfreeSignature({ payload, timestamp, signature: sig, secret })).toBe(true);
    expect(verifyCashfreeSignature({ payload, timestamp, signature: 'wrong', secret })).toBe(false);
  });
});

// ─── 2. config-guard requires the active provider's webhook secret ───────────
describe('config-guard — billing webhook secret requirement', () => {
  const baseSecure = {
    NODE_ENV: 'production',
    JWT_SECRET: 'jwt_7Kq2mZ9pX4rT8vB1nW6yL3cD5fH0gJ8a',
    ENCRYPTION_KEY: 'enc_R4tY7uI2oP9aS6dF3gH1jK8lZ5xC0vB7',
    VERP_SECRET: 'verp_M3nB7vC2xZ9qW5e',
    API_KEY_PEPPER: 'pep_Q1wE4rT7yU2iO9pA6sD3fG8hJ5kL0zX2',
    ADMIN_SESSION_PEPPER: 'asp_Z9xC6vB3nM1qW7eR4tY2uI8oP5aS0dF3',
    ADMIN_PASSWORD_LOGIN_DISABLED: 'true',
    OIDC_ISSUER_URL: 'https://idp.test',
    OIDC_CLIENT_ID: 'mail-platform-admin',
  } as Record<string, string>;

  it('requires STRIPE_WEBHOOK_SECRET when Stripe is the live provider', () => {
    const env = { ...baseSecure, BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_live_x' };
    const r = checkConfig(env as any);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('STRIPE_WEBHOOK_SECRET'))).toBe(true);
  });

  it('passes when the Stripe webhook secret is present and strong', () => {
    const env = {
      ...baseSecure,
      BILLING_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: 'sk_live_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_8Hj3kP9mR2nQ5vL7xW1c',
    };
    const r = checkConfig(env as any);
    expect(r.ok).toBe(true);
  });

  it('does NOT require a Stripe webhook secret when provider is mock (no live key)', () => {
    const env = { ...baseSecure, BILLING_PROVIDER: 'mock' };
    const r = checkConfig(env as any);
    expect(r.errors.some((e) => e.includes('WEBHOOK_SECRET'))).toBe(false);
  });

  it('requires CASHFREE_WEBHOOK_SECRET only when Cashfree is live-configured', () => {
    const env = {
      ...baseSecure,
      BILLING_PROVIDER: 'cashfree',
      CASHFREE_APP_ID: 'app',
      CASHFREE_SECRET_KEY: 'sec',
    };
    const r = checkConfig(env as any);
    expect(r.errors.some((e) => e.includes('CASHFREE_WEBHOOK_SECRET'))).toBe(true);
  });
});

// ─── 3. metricsAuthorized ────────────────────────────────────────────────────
describe('metricsAuthorized', () => {
  it('allows scrapes without a token outside production', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.METRICS_TOKEN;
    expect(metricsAuthorized({})).toBe(true);
  });

  it('DENIES scrapes without a token in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.METRICS_TOKEN;
    expect(metricsAuthorized({})).toBe(false);
  });

  it('accepts the correct bearer token and rejects a wrong one', () => {
    process.env.NODE_ENV = 'production';
    process.env.METRICS_TOKEN = 'super-secret-scrape-token';
    expect(metricsAuthorized({ authorization: 'Bearer super-secret-scrape-token' })).toBe(true);
    expect(metricsAuthorized({ authorization: 'Bearer nope' })).toBe(false);
    expect(metricsAuthorized({})).toBe(false);
  });

  it('accepts the token via ?token= query param', () => {
    process.env.NODE_ENV = 'production';
    process.env.METRICS_TOKEN = 'qtok';
    expect(metricsAuthorized({ token: 'qtok' })).toBe(true);
    expect(metricsAuthorized({ token: 'bad' })).toBe(false);
  });

  it('rejects a token of differing length without throwing (constant-time guard)', () => {
    process.env.NODE_ENV = 'production';
    process.env.METRICS_TOKEN = 'exacttoken';
    expect(metricsAuthorized({ authorization: 'Bearer short' })).toBe(false);
  });
});
