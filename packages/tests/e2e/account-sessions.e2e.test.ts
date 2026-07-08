// E2E: active-session management over HTTP.
// list sessions, revoke a specific session, "log out everywhere else", and
// the owner-scoping / auth guards around them.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './harness.js';
import { CapturingPlatformMailer, setPlatformMailer } from '@platform/shared';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
  setPlatformMailer(new CapturingPlatformMailer());
});
afterAll(async () => {
  await app.close();
  setPlatformMailer(null);
});

function uniqueEmail(p: string): string {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function register(email: string, password = 'a-good-long-password') {
  const res = await app.inject({
    method: 'POST', url: '/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { email, password, org_name: 'Session Org' },
  });
  return res.json().token as string;
}

async function login(email: string, password = 'a-good-long-password') {
  const res = await app.inject({
    method: 'POST', url: '/v1/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function listSessions(token: string) {
  const res = await app.inject({ method: 'GET', url: '/v1/auth/sessions', headers: bearer(token) });
  return res;
}

describe('E2E active sessions', () => {
  it('lists all of a user\'s sessions and flags the current one', async () => {
    const email = uniqueEmail('multi');
    const tokenA = await register(email); // session A
    const tokenB = await login(email); // session B

    const res = await listSessions(tokenA);
    expect(res.statusCode).toBe(200);
    const sessions = res.json().sessions;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    const current = sessions.filter((s: any) => s.current);
    expect(current).toHaveLength(1); // exactly one marked current (this request's)
    // metadata only — no token/hash leaks
    expect(sessions[0].token).toBeUndefined();
    expect(sessions[0].token_hash).toBeUndefined();
    expect(tokenB).toBeTruthy();
  });

  it('revokes a specific session so its token stops working', async () => {
    const email = uniqueEmail('revoke-one');
    const tokenA = await register(email);
    const tokenB = await login(email);

    // From A, find B's session id (B is current=false in A's list).
    const sessions = (await listSessions(tokenA)).json().sessions;
    const other = sessions.find((s: any) => !s.current);
    expect(other).toBeTruthy();

    const del = await app.inject({ method: 'DELETE', url: `/v1/auth/sessions/${other.id}`, headers: bearer(tokenA) });
    expect(del.statusCode).toBe(200);

    // The revoked session's token should now be rejected.
    const afterRevoke = await app.inject({ method: 'GET', url: '/v1/auth/sessions', headers: bearer(tokenB) });
    expect(afterRevoke.statusCode).toBe(401);
    // A still works.
    expect((await listSessions(tokenA)).statusCode).toBe(200);
  });

  it('"revoke others" keeps the current session and drops the rest', async () => {
    const email = uniqueEmail('others');
    const tokenA = await register(email);
    const tokenB = await login(email);
    const tokenC = await login(email);

    const res = await app.inject({ method: 'POST', url: '/v1/auth/sessions/revoke-others', headers: bearer(tokenA) });
    expect(res.statusCode).toBe(200);
    expect(res.json().revoked).toBeGreaterThanOrEqual(2);

    // A survives; B and C are gone.
    expect((await listSessions(tokenA)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/auth/sessions', headers: bearer(tokenB) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/auth/sessions', headers: bearer(tokenC) })).statusCode).toBe(401);
    // Only the current session remains.
    expect((await listSessions(tokenA)).json().sessions).toHaveLength(1);
  });

  it('cannot revoke a session belonging to another user (404)', async () => {
    const victimToken = await register(uniqueEmail('victim'));
    const victimSessionId = (await listSessions(victimToken)).json().sessions[0].id;

    const attackerToken = await register(uniqueEmail('attacker'));
    const del = await app.inject({ method: 'DELETE', url: `/v1/auth/sessions/${victimSessionId}`, headers: bearer(attackerToken) });
    expect(del.statusCode).toBe(404);

    // The victim's session is untouched.
    expect((await listSessions(victimToken)).statusCode).toBe(200);
  });

  it('requires authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/auth/sessions' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/sessions/revoke-others' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/v1/auth/sessions/00000000-0000-0000-0000-000000000000' })).statusCode).toBe(401);
  });
});
