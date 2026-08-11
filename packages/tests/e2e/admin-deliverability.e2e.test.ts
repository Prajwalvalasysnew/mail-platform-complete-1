import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildTestApp,
  seedAdminSession,
  seedCustomer,
  seedMessages,
} from './harness.js';
import { db } from '@platform/shared';

let app: FastifyInstance;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('admin deliverability API', () => {
  it('shows pause and recovery health to support operators', async () => {
    const support = await seedAdminSession('support');
    const tenant = await seedCustomer();
    const pool = `release-gate-${Date.now()}`;

    try {
      await seedMessages(tenant.customerId, { count: 500, status: 'delivered', ipPool: pool });
      await seedMessages(tenant.customerId, { count: 30, status: 'hard_bounced', ipPool: pool });

      const unhealthy = await app.inject({
        method: 'GET',
        url: '/admin/deliverability/pool-health',
        headers: auth(support.token),
      });
      expect(unhealthy.statusCode).toBe(200);
      expect(unhealthy.json().pools).toContainEqual(expect.objectContaining({
        pool,
        sent: 530,
        bounced: 30,
        action: 'pause',
      }));

      await db.deleteFrom('messages').where('customer_id', '=', tenant.customerId).execute();
      await seedMessages(tenant.customerId, { count: 500, status: 'delivered', ipPool: pool });
      const recovered = await app.inject({
        method: 'GET',
        url: '/admin/deliverability/pool-health',
        headers: auth(support.token),
      });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json().pools).toContainEqual(expect.objectContaining({
        pool,
        sent: 500,
        bounced: 0,
        action: 'ok',
      }));
    } finally {
      await db.deleteFrom('messages').where('customer_id', '=', tenant.customerId).execute();
    }
  });

  it('returns the combined pool/IP/blocklist reputation view', async () => {
    const support = await seedAdminSession('support');
    const response = await app.inject({
      method: 'GET',
      url: '/admin/reputation/pools',
      headers: auth(support.token),
    });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json().pools)).toBe(true);
    expect(response.json().pools.length).toBeGreaterThan(0);
    expect(response.json().pools.some((pool: any) =>
      Array.isArray(pool.ips) && pool.ips.some((ip: any) =>
        typeof ip.ip === 'string' &&
        Array.isArray(ip.blocklist_listings) &&
        Object.hasOwn(ip, 'reputation_snapshot'),
      ),
    )).toBe(true);
  });

  it('requires authentication and separates read from scan authority', async () => {
    const support = await seedAdminSession('support');
    expect((await app.inject({
      method: 'GET',
      url: '/admin/deliverability/pool-health',
    })).statusCode).toBe(401);

    const denied = await app.inject({
      method: 'POST',
      url: '/admin/deliverability/blocklist-scan',
      headers: auth(support.token),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('lets an operator run the real DNSBL scan and audits the action', async () => {
    const operator = await seedAdminSession('operator');
    const response = await app.inject({
      method: 'POST',
      url: '/admin/deliverability/blocklist-scan',
      headers: auth(operator.token),
    });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json().listings)).toBe(true);

    const audit = await db.selectFrom('audit_log')
      .select(['action', 'resource', 'metadata'])
      .where('action', '=', 'admin:blocklist_scan')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    expect(audit).toMatchObject({
      action: 'admin:blocklist_scan',
      resource: 'sending_ips',
    });
    expect(audit?.metadata).toMatchObject({
      listings: expect.any(Number),
      admin_user_id: operator.adminUserId,
    });
  });
});
