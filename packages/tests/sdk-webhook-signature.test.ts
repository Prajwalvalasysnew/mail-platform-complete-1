// Regression test for the SDK <-> platform webhook signature mismatch found in
// the gap analysis: the worker signs HMAC(secret, `${ts}.${body}`) and sends
// `X-MP-Signature: t=<ts>,v1=<hex>`, but the old SDK helper verified
// HMAC(secret, body) against a bare `sha256=<hex>` header — so every real
// delivery failed verification. This proves the two sides now agree.
import { describe, expect, it } from 'vitest';
import { signWebhook } from '@platform/shared';
import { verifyWebhookSignature, verifyWebhookSignatureAsync } from '../sdk/src/index.js';

function makeHeader(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  return { header: `t=${ts},v1=${signWebhook(secret, body, ts)}`, ts };
}

describe('SDK webhook verification matches worker signing', () => {
  const secret = 'whsec_test_secret_1234567890';
  const body = JSON.stringify({ event_type: 'delivered', message_id: '<abc@example.com>' });

  it('accepts a genuine worker-signed delivery (sync)', () => {
    const { header } = makeHeader(secret, body);
    expect(verifyWebhookSignature(body, header, secret)).toBe(true);
  });

  it('accepts a genuine worker-signed delivery (async / WebCrypto)', async () => {
    const { header } = makeHeader(secret, body);
    await expect(verifyWebhookSignatureAsync(body, header, secret)).resolves.toBe(true);
  });

  it('rejects a tampered body', () => {
    const { header } = makeHeader(secret, body);
    expect(verifyWebhookSignature(body + 'x', header, secret)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const { header } = makeHeader(secret, body);
    expect(verifyWebhookSignature(body, header, 'whsec_wrong')).toBe(false);
  });

  it('rejects a replayed (stale) timestamp beyond tolerance', () => {
    const staleTs = Math.floor(Date.now() / 1000) - 3600;
    const { header } = makeHeader(secret, body, staleTs);
    expect(verifyWebhookSignature(body, header, secret)).toBe(false);
    // ...but accepts it when tolerance is explicitly widened
    expect(verifyWebhookSignature(body, header, secret, { toleranceSeconds: 7200 })).toBe(true);
  });

  it('rejects a forged timestamp (signature covers t, so t cannot be moved)', () => {
    const staleTs = Math.floor(Date.now() / 1000) - 3600;
    const sig = signWebhook(secret, body, staleTs);
    const forged = `t=${Math.floor(Date.now() / 1000)},v1=${sig}`;
    expect(verifyWebhookSignature(body, forged, secret)).toBe(false);
  });

  it('supports secret rotation (array of secrets, any may match)', () => {
    const { header } = makeHeader(secret, body);
    expect(verifyWebhookSignature(body, header, ['whsec_new_secret', secret])).toBe(true);
    expect(verifyWebhookSignature(body, header, ['whsec_a', 'whsec_b'])).toBe(false);
  });

  it('supports multiple v1 entries in the header (rotation window on sender side)', () => {
    const ts = Math.floor(Date.now() / 1000);
    const other = signWebhook('some_other_secret', body, ts);
    const real = signWebhook(secret, body, ts);
    const header = `t=${ts},v1=${other},v1=${real}`;
    expect(verifyWebhookSignature(body, header, secret)).toBe(true);
  });

  it('rejects malformed headers', () => {
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(body, '', secret)).toBe(false);
    expect(verifyWebhookSignature(body, 'sha256=deadbeef', secret)).toBe(false);
    expect(verifyWebhookSignature(body, 't=notanumber,v1=deadbeef', secret)).toBe(false);
    expect(verifyWebhookSignature(body, `t=${Math.floor(Date.now() / 1000)}`, secret)).toBe(false);
  });
});
