// Regression test for the Cashfree webhook timestamp bug found in the gap
// analysis: Cashfree's documented x-webhook-timestamp is in MILLISECONDS
// (13-digit, e.g. 1746427759733), but the code multiplied it by 1000 as if it
// were seconds — making every live Cashfree webhook look ~55 years stale and
// fail the freshness check. Local tests previously only exercised the (wrong)
// seconds assumption, so they passed while production would have failed.
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { verifyCashfreeSignature } from '../api/src/routes/billing.js';

function sign(secret: string, timestamp: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(timestamp + payload).digest('base64');
}

describe('Cashfree webhook timestamp handling', () => {
  const secret = 'cf_test_secret';
  const payload = JSON.stringify({ type: 'SUBSCRIPTION_ACTIVATED', data: {} });

  it('accepts a real Cashfree-style millisecond timestamp (13 digits)', () => {
    const tsMs = String(Date.now()); // e.g. "1746427759733"
    const signature = sign(secret, tsMs, payload);
    expect(
      verifyCashfreeSignature({ payload, timestamp: tsMs, signature, secret })
    ).toBe(true);
  });

  it('still accepts a seconds-style timestamp (10 digits) for backward compatibility', () => {
    const tsSec = String(Math.floor(Date.now() / 1000));
    const signature = sign(secret, tsSec, payload);
    expect(
      verifyCashfreeSignature({ payload, timestamp: tsSec, signature, secret })
    ).toBe(true);
  });

  it('rejects a stale millisecond timestamp beyond the freshness window', () => {
    const staleMs = String(Date.now() - 10 * 60_000); // 10 minutes old
    const signature = sign(secret, staleMs, payload);
    expect(
      verifyCashfreeSignature({ payload, timestamp: staleMs, signature, secret })
    ).toBe(false);
  });

  it('rejects a mismatched signature', () => {
    const tsMs = String(Date.now());
    expect(
      verifyCashfreeSignature({ payload, timestamp: tsMs, signature: 'bogus', secret })
    ).toBe(false);
  });

  it('with the OLD (buggy) seconds*1000 logic, a real millisecond timestamp would have been rejected', () => {
    // Documents the bug this test file guards against: interpreting a real
    // 13-digit ms timestamp as seconds-then-*1000 lands ~1000x in the future,
    // which is why production Cashfree webhooks would have failed silently.
    const tsMs = Date.now();
    const buggyInterpretation = tsMs * 1000; // what the old code computed
    expect(Math.abs(Date.now() - buggyInterpretation)).toBeGreaterThan(300_000);
  });
});
