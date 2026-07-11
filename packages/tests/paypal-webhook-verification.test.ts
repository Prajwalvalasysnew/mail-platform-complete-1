import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyPayPalSignature, setPayPalWebhookVerifierForTests } from '@platform/api/routes/billing.js';

const original = {
  clientId: process.env.PAYPAL_CLIENT_ID,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET,
  webhookId: process.env.PAYPAL_WEBHOOK_ID,
  baseUrl: process.env.PAYPAL_API_BASE_URL,
};

function restoreEnv(name: keyof typeof original): void {
  const value = original[name];
  if (value === undefined) delete process.env[name === 'clientId' ? 'PAYPAL_CLIENT_ID' : name === 'clientSecret' ? 'PAYPAL_CLIENT_SECRET' : name === 'webhookId' ? 'PAYPAL_WEBHOOK_ID' : 'PAYPAL_API_BASE_URL'];
  else process.env[name === 'clientId' ? 'PAYPAL_CLIENT_ID' : name === 'clientSecret' ? 'PAYPAL_CLIENT_SECRET' : name === 'webhookId' ? 'PAYPAL_WEBHOOK_ID' : 'PAYPAL_API_BASE_URL'] = value;
}

afterEach(() => {
  restoreEnv('clientId');
  restoreEnv('clientSecret');
  restoreEnv('webhookId');
  restoreEnv('baseUrl');
  setPayPalWebhookVerifierForTests();
  vi.unstubAllGlobals();
});

function input() {
  return {
    event: { id: 'WH-event', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED' },
    transmissionId: 'transmission-1',
    transmissionTime: new Date().toISOString(),
    signature: 'provider-signature',
    certUrl: 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1',
    authAlgo: 'SHA256withRSA',
  };
}

describe('PayPal official webhook verification', () => {
  it('obtains an OAuth token then posts the required official verification payload', async () => {
    process.env.PAYPAL_CLIENT_ID = 'paypal-client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'paypal-client-secret';
    process.env.PAYPAL_WEBHOOK_ID = 'WH-12345678';
    process.env.PAYPAL_API_BASE_URL = 'https://api-m.sandbox.paypal.com';
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'access-token' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ verification_status: 'SUCCESS' }) });
    vi.stubGlobal('fetch', fetch);

    await expect(verifyPayPalSignature(input())).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![0]).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
    expect(fetch.mock.calls[1]![0]).toBe('https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature');
    const body = JSON.parse(fetch.mock.calls[1]![1].body as string);
    expect(body).toMatchObject({
      webhook_id: 'WH-12345678',
      transmission_id: 'transmission-1',
      transmission_sig: 'provider-signature',
      auth_algo: 'SHA256withRSA',
      cert_url: input().certUrl,
    });
  });

  it('fails closed when PayPal does not return SUCCESS or mandatory headers are absent', async () => {
    process.env.PAYPAL_CLIENT_ID = 'paypal-client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'paypal-client-secret';
    process.env.PAYPAL_WEBHOOK_ID = 'WH-12345678';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'access-token' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ verification_status: 'FAILURE' }) }));

    await expect(verifyPayPalSignature(input())).resolves.toBe(false);
    await expect(verifyPayPalSignature({ ...input(), certUrl: undefined })).resolves.toBe(false);
  });
});
