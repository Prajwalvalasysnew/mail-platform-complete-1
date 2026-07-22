import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { redis } from '@platform/shared';

beforeAll(() => {
  process.env.SMTP_GATEWAY_AUTOSTART = 'false';
});

afterEach(async () => {
  delete process.env.SMTP_FREE_MESSAGES_PER_MINUTE;
  const keys = await redis.keys('smtp:rate:*:rate-limit-test-*');
  if (keys.length) await redis.del(...keys);
});

describe('SMTP gateway resource protection', () => {
  it('enforces a distributed fixed-window allowance', async () => {
    const { consumeSmtpRateLimit } = await import('@platform/smtp-gateway/gateway.js');
    const identity = `rate-limit-test-${randomUUID()}`;

    await expect(consumeSmtpRateLimit('customer', identity, 2)).resolves.toBe(true);
    await expect(consumeSmtpRateLimit('customer', identity, 2)).resolves.toBe(true);
    await expect(consumeSmtpRateLimit('customer', identity, 2)).resolves.toBe(false);
  });

  it('applies the plan-aware per-customer submission gate', async () => {
    process.env.SMTP_FREE_MESSAGES_PER_MINUTE = '1';
    const { enforceSmtpCustomerRate } = await import('@platform/smtp-gateway/gateway.js');
    const auth = {
      customer_id: `rate-limit-test-${randomUUID()}`,
      api_key_id: randomUUID(),
      tier: 'free',
      test_mode: false,
    };

    await expect(enforceSmtpCustomerRate(auth)).resolves.toBeUndefined();
    await expect(enforceSmtpCustomerRate(auth)).rejects.toMatchObject({
      responseCode: 452,
      message: expect.stringMatching(/rate exceeded/i),
    });
  });

  it('configures global connection and timeout caps on the SMTP server', async () => {
    const { buildSmtpServer } = await import('@platform/smtp-gateway');
    const server = buildSmtpServer() as any;

    expect(server.options.maxClients).toBeGreaterThan(0);
    expect(server.options.socketTimeout).toBeGreaterThan(0);
    expect(server.options.closeTimeout).toBeGreaterThan(0);
  });
});
