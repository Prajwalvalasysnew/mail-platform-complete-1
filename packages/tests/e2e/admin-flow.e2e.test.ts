// End-to-end admin plane: password login, session/me/logout, RBAC enforcement,
// admin-user management (superadmin), customer plan/quota management, and the
// platform overview. Exercises the routes through the real Fastify app.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp } from './harness.js';
import { db, createAdminUser, seedCustomer } from '@platform/shared';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let superToken: string;

const SUPER_EMAIL = `super-${Date.now()}@admin.test`;
const SUPER_PW = 'super-secret-password-123';

beforeAll(async () => {
  app = await buildTestApp();
  // Bootstrap a superadmin (first admin is always provisioned out-of-band).
  const r = await createAdminUser({ email: SUPER_EMAIL, name: 'Root', role: 'superadmin', password: SUPER_PW });
  if ('error' in r) throw new Error('bootstrap failed');
});

afterAll(async () => {
  await app.close();
});

async function login(email: string, password: string) {
  return app.inject({ method: 'POST', url: '/admin/auth/login', payload: { email, password } });
}

describe('admin auth', () => {
  it('rejects bad credentials with 401', async () => {
    const res = await login(SUPER_EMAIL, 'wrong-password');
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_credentials');
  });

  it('can disable password admin login for SSO-only production mode', async () => {
    const old = process.env.ADMIN_PASSWORD_LOGIN_DISABLED;
    process.env.ADMIN_PASSWORD_LOGIN_DISABLED = 'true';
    try {
      const res = await login(SUPER_EMAIL, SUPER_PW);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('password_login_disabled');
    } finally {
      if (old === undefined) delete process.env.ADMIN_PASSWORD_LOGIN_DISABLED;
      else process.env.ADMIN_PASSWORD_LOGIN_DISABLED = old;
    }
  });

  it('logs in with a valid password and returns a session token', async () => {
    const res = await login(SUPER_EMAIL, SUPER_PW);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toMatch(/^mpadm_/);
    expect(body.role).toBe('superadmin');
    expect(body.expires_at).toBeTruthy();
    superToken = body.token;
  });

  it('resolves the current admin via /auth/me', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/auth/me', headers: { authorization: `Bearer ${superToken}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe(SUPER_EMAIL.toLowerCase());
    expect(res.json().role).toBe('superadmin');
  });

  it('rejects requests with no/invalid token', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/auth/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/admin/auth/me', headers: { authorization: 'Bearer mpadm_bogus' } })).statusCode).toBe(401);
  });
});

describe('admin user management (superadmin)', () => {
  let supportId: string;
  let supportToken: string;

  it('creates a support admin', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/admins',
      headers: { authorization: `Bearer ${superToken}` },
      payload: { email: `agent-${Date.now()}@admin.test`, name: 'Agent', role: 'support', password: 'agent-password-1234' },
    });
    expect(res.statusCode).toBe(201);
    supportId = res.json().id;
    supportToken = (await login(res.json().email, 'agent-password-1234')).json().token;
    expect(supportToken).toMatch(/^mpadm_/);
  });

  it('lists admins', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/admins', headers: { authorization: `Bearer ${superToken}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().admins.length).toBeGreaterThanOrEqual(2);
  });

  it('enforces RBAC: a support admin cannot list admins (needs superadmin)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/admins', headers: { authorization: `Bearer ${supportToken}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('insufficient_role');
  });

  it('disabling an admin kills their live session', async () => {
    const patch = await app.inject({ method: 'PATCH', url: `/admin/admins/${supportId}`, headers: { authorization: `Bearer ${superToken}` }, payload: { disabled: true } });
    expect(patch.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/admin/auth/me', headers: { authorization: `Bearer ${supportToken}` } });
    expect(me.statusCode).toBe(401); // session revoked
  });

  it('prevents a superadmin from self-demoting/locking out', async () => {
    const me = await app.inject({ method: 'GET', url: '/admin/auth/me', headers: { authorization: `Bearer ${superToken}` } });
    const myId = me.json().admin_user_id;
    const res = await app.inject({ method: 'PATCH', url: `/admin/admins/${myId}`, headers: { authorization: `Bearer ${superToken}` }, payload: { disabled: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('cannot_self_demote');
  });
});

describe('customer management + overview', () => {
  it('updates a customer tier and quota', async () => {
    const c = await seedCustomer();
    const res = await app.inject({
      method: 'PATCH', url: `/admin/customers/${c.customerId}`,
      headers: { authorization: `Bearer ${superToken}` },
      payload: { tier: 'enterprise', daily_quota: 50000, monthly_quota: 1000000 },
    });
    expect(res.statusCode).toBe(200);
    const row = await db.selectFrom('customers').select(['tier', 'daily_quota', 'monthly_quota']).where('id', '=', c.customerId).executeTakeFirstOrThrow();
    expect(row.tier).toBe('enterprise');
    expect(Number(row.daily_quota)).toBe(50000);
    expect(Number(row.monthly_quota)).toBe(1000000);
  });

  it('404s updating a missing customer', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/admin/customers/00000000-0000-0000-0000-000000000000`, headers: { authorization: `Bearer ${superToken}` }, payload: { tier: 'paid' } });
    expect(res.statusCode).toBe(404);
  });

  it('returns a platform overview', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/overview', headers: { authorization: `Bearer ${superToken}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('customers_by_status');
    expect(body).toHaveProperty('messages_24h');
    expect(body).toHaveProperty('rates_24h');
    expect(body).toHaveProperty('send_queue');
    expect(body).toHaveProperty('suppressions_total');
  });
});

describe('admin logout', () => {
  it('revokes the session', async () => {
    const token = (await login(SUPER_EMAIL, SUPER_PW)).json().token;
    expect((await app.inject({ method: 'POST', url: '/admin/auth/logout', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/admin/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(401);
  });
});
