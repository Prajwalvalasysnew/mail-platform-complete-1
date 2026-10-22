// E2E: BASE-04 (compliance implementation plan) — account-holder data-subject
// workflows, independent of the recipient-email privacy endpoints.
//
// GET /v1/auth/me/export   — authenticated self-export of account data.
// DELETE /v1/auth/me       — self-service account deletion: anonymizes the
//                            user row, removes credentials/sessions/tokens/
//                            memberships, blocks sole owners (409), and never
//                            retains the plaintext email on the disabled row.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './harness.js';
import {randomUUID} from 'node:crypto';
import { db, withTenant, CapturingPlatformMailer, setPlatformMailer } from '@platform/shared';

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
    payload: { email, password, name: 'Data Subject', org_name: 'DSAR Org' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().token as string;
}

async function seedChat(userId:string){
 const membership=await db.selectFrom('memberships').select('customer_id').where('user_id','=',userId).executeTakeFirstOrThrow();const id=randomUUID();
 await withTenant(membership.customer_id,async trx=>{
  await trx.insertInto('ai_chats').values({id,customer_id:membership.customer_id,user_id:userId,title:'Private chat fixture',settings:{mem:{voice:'Plain'}},expires_at:new Date(Date.now()+86400000)}).execute();
  await trx.insertInto('ai_chat_messages').values({id:randomUUID(),customer_id:membership.customer_id,chat_id:id,run_id:null,seq:1,role:'user',text:'Private conversation text',status:'completed',result:{context_settings:{}},error:null,template_id:null,decision:null}).execute();
 });return {id,cid:membership.customer_id};
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

describe('BASE-04 account-holder data-subject workflows', () => {
  it('exports the authenticated user\'s account data without secrets', async () => {
    const email = uniqueEmail('self-export');
    const token = await register(email);
    const userId=(await db.selectFrom('users').select('id').where('email','=',email).executeTakeFirstOrThrow()).id;
    const chat=await seedChat(userId);

    const res = await app.inject({ method: 'GET', url: '/v1/auth/me/export', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ai_chats.some((entry:any)=>entry.chat.id===chat.id && entry.messages[0].text==='Private conversation text')).toBe(true);
    expect(body.user.email).toBe(email);
    expect(body.user.name).toBe('Data Subject');
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0].role).toBe('owner');
    expect(body.sessions.length).toBeGreaterThanOrEqual(1);
    expect(body.exclusions.length).toBeGreaterThanOrEqual(1);
    // No credential material may leak.
    const raw = res.body;
    expect(raw).not.toContain('password_hash');
    expect(raw).not.toContain('secret_encrypted');
    expect(raw).not.toContain('token_hash');
    expect(raw).not.toContain('public_key');
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/me/export' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses deletion for a sole org owner with 409', async () => {
    const email = uniqueEmail('sole-owner');
    const token = await register(email);

    const res = await app.inject({
      method: 'DELETE', url: '/v1/auth/me', headers: bearer(token),
      payload: { confirm: 'delete my account' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('sole_owner');
    expect(res.json().customer_ids).toHaveLength(1);
  });

  it('requires the confirmation phrase', async () => {
    const email = uniqueEmail('no-confirm');
    const token = await register(email);
    const res = await app.inject({
      method: 'DELETE', url: '/v1/auth/me', headers: bearer(token), payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('confirmation_required');
  });

  it('deletes a non-sole-owner account: anonymized row, dead sessions, no plaintext email', async () => {
    const email = uniqueEmail('self-delete');
    const token = await register(email);
    const userId = (await db.selectFrom('users').select('id')
      .where('email', '=', email).executeTakeFirstOrThrow()).id;
    const chat=await seedChat(userId);
    // Add a second owner so the sole-owner gate does not block.
    const coOwnerEmail = uniqueEmail('co-owner');
    await register(coOwnerEmail);
    const coOwner = await db.selectFrom('users').select('id')
      .where('email', '=', coOwnerEmail).executeTakeFirstOrThrow();
    const org = await db.selectFrom('memberships').select('customer_id')
      .where('user_id', '=', userId).executeTakeFirstOrThrow();
    await db.insertInto('memberships')
      .values({ user_id: coOwner.id, customer_id: org.customer_id, role: 'owner' })
      .execute();

    const res = await app.inject({
      method: 'DELETE', url: '/v1/auth/me', headers: bearer(token),
      payload: { confirm: 'delete my account' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
    expect(await withTenant(chat.cid,trx=>trx.selectFrom('ai_chats').select('id').where('id','=',chat.id).executeTakeFirst())).toBeUndefined();

    // The user row survives only as a disabled, anonymized shell.
    const row = await db.selectFrom('users')
      .select(['email', 'name', 'password_hash', 'status'])
      .where('id', '=', userId).executeTakeFirstOrThrow();
    expect(row.email).toMatch(/^erased-[0-9a-f]{32}@erased\.invalid$/);
    expect(row.name).toBeNull();
    expect(row.password_hash).toBeNull();
    expect(row.status).toBe('disabled');

    // Credentials, sessions, and memberships are gone; the token is dead.
    for (const table of ['mfa_factors', 'user_sessions', 'memberships', 'user_tokens', 'webauthn_credentials'] as const) {
      const left = await db.selectFrom(table).select('user_id').where('user_id', '=', userId).execute();
      expect(left, table).toHaveLength(0);
    }
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: bearer(token) });
    expect(me.statusCode).toBe(401);
  });
});
