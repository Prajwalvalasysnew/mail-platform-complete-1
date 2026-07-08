import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  db,
  listMembersOfCustomer,
  updateMembershipRole,
  removeMembership,
  getMembership,
  createInvite,
  listInvites,
  revokeInvite,
  acceptInvite,
  createUserSession,
  recordAuditSafe,
  sendTeamInviteEmail,
  createScimToken,
  listScimTokens,
  revokeScimToken,
  type MembershipRole,
} from '@platform/shared';
import { requireFullUser, requireCapability } from '../plugins/session-auth.js';

const RoleSchema = z.enum(['owner', 'admin', 'developer', 'analyst', 'billing']);
const exposeDevTokens = process.env.NODE_ENV !== 'production';

export const teamRoutes: FastifyPluginAsync = async (app) => {
  // List teammates in the active org (any member may view).
  app.get('/team/members', { preHandler: requireFullUser }, async (req, reply) => {
    const orgId = req.user!.current_customer_id;
    if (!orgId) return reply.code(403).send({ error: 'no_active_org' });
    return { members: await listMembersOfCustomer(orgId) };
  });

  // Invite a teammate.
  const InviteSchema = z.object({ email: z.string().email(), role: RoleSchema });
  app.post('/team/invites', { preHandler: requireCapability('members:manage') }, async (req, reply) => {
    const parsed = InviteSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    // Only an owner may grant the owner role.
    if (parsed.data.role === 'owner' && req.user!.current_role !== 'owner') {
      return reply.code(403).send({ error: 'only_owner_can_grant_owner' });
    }
    const orgId = req.user!.current_customer_id!;
    const invite = await createInvite(orgId, parsed.data.email, parsed.data.role as MembershipRole, req.user!.user_id);
    recordAuditSafe({ customerId: orgId, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email, action: 'team.invite_created', resource: parsed.data.email, metadata: { role: parsed.data.role }, ip: req.ip });
    try {
      const org = await db.selectFrom('customers').select(['name']).where('id', '=', orgId).executeTakeFirst();
      await sendTeamInviteEmail({ to: parsed.data.email, token: invite.token, orgName: org?.name ?? null, inviterName: req.user!.email });
    } catch (err) {
      req.log.error({ err, org_id: orgId }, 'failed to send invite email');
    }
    return reply.code(201).send({
      invite_id: invite.invite_id,
      ...(exposeDevTokens ? { _dev_invite_token: invite.token } : {}),
    });
  });

  app.get('/team/invites', { preHandler: requireCapability('members:manage') }, async (req) => {
    return { invites: await listInvites(req.user!.current_customer_id!) };
  });

  app.delete('/team/invites/:id', { preHandler: requireCapability('members:manage') }, async (req) => {
    const { id } = req.params as { id: string };
    await revokeInvite(req.user!.current_customer_id!, id);
    return { ok: true };
  });

  // Accept an invite — public (the invitee may have no account yet).
  const AcceptSchema = z.object({
    token: z.string(),
    name: z.string().min(1).max(100).optional(),
    password: z.string().min(8).max(200).optional(),
  });
  app.post('/team/invites/accept', async (req, reply) => {
    const parsed = AcceptSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed' });
    const result = await acceptInvite(parsed.data.token, { name: parsed.data.name, password: parsed.data.password });
    if ('error' in result) {
      const code = result.error === 'password_required' ? 400 : 410;
      return reply.code(code).send({ error: result.error });
    }
    // Start a session in the joined org.
    //
    // SECURITY: a session from an invite link must never satisfy MFA for a
    // user who has MFA enrolled — an invite token is not a second factor.
    // Brand-new users (just created a password here) have no MFA yet, so a
    // satisfied session is fine. Existing users with MFA get an UNSATISFIED
    // session and must complete the normal MFA challenge before any route
    // guarded by requireFullUser / MFA enforcement.
    const mfaSatisfied = !result.mfa_enabled;
    const session = await createUserSession(result.user_id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      mfaSatisfied,
      currentCustomerId: result.customer_id,
    });
    recordAuditSafe({ customerId: result.customer_id, actorType: 'user', actorId: result.user_id, action: 'team.invite_accepted', ip: req.ip });
    return reply
      .code(201)
      .send({ token: session.token, customer_id: result.customer_id, mfa_required: !mfaSatisfied });
  });

  // Change a member's role.
  const ChangeRoleSchema = z.object({ role: RoleSchema });
  app.patch('/team/members/:userId', { preHandler: requireCapability('members:manage') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const parsed = ChangeRoleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed' });
    const orgId = req.user!.current_customer_id!;

    const target = await getMembership(userId, orgId);
    if (!target) return reply.code(404).send({ error: 'not_a_member' });
    // Only an owner may change an owner or grant the owner role.
    if ((target.role === 'owner' || parsed.data.role === 'owner') && req.user!.current_role !== 'owner') {
      return reply.code(403).send({ error: 'only_owner_can_manage_owner' });
    }
    const res = await updateMembershipRole(orgId, userId, parsed.data.role as MembershipRole);
    if (!res.ok) return reply.code(409).send({ error: res.error });
    recordAuditSafe({ customerId: orgId, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email, action: 'team.role_changed', resource: userId, metadata: { from: target.role, to: parsed.data.role }, ip: req.ip });
    return { ok: true };
  });

  // Remove a member.
  app.delete('/team/members/:userId', { preHandler: requireCapability('members:manage') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const orgId = req.user!.current_customer_id!;
    const target = await getMembership(userId, orgId);
    if (!target) return reply.code(404).send({ error: 'not_a_member' });
    if (target.role === 'owner' && req.user!.current_role !== 'owner') {
      return reply.code(403).send({ error: 'only_owner_can_remove_owner' });
    }
    const res = await removeMembership(orgId, userId);
    if (!res.ok) return reply.code(409).send({ error: res.error });
    recordAuditSafe({ customerId: orgId, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email, action: 'team.member_removed', resource: userId, metadata: { role: target.role }, ip: req.ip });
    return { ok: true };
  });

  // ─── SCIM provisioning tokens (gap analysis #9) ────────────────────────────
  // An org admin mints a bearer token that their IdP (Okta/Entra) uses to
  // provision/deprovision users via /scim/v2/*. Plaintext is shown once.
  app.get('/team/scim-tokens', { preHandler: requireCapability('members:manage') }, async (req) => {
    const orgId = req.user!.current_customer_id!;
    return { tokens: await listScimTokens(orgId) };
  });

  app.post('/team/scim-tokens', { preHandler: requireCapability('members:manage') }, async (req, reply) => {
    const orgId = req.user!.current_customer_id!;
    const body = (req.body ?? {}) as { label?: string };
    const created = await createScimToken(orgId, typeof body.label === 'string' ? body.label.slice(0, 100) : undefined);
    recordAuditSafe({ customerId: orgId, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email, action: 'scim.token_created', resource: created.id, metadata: { prefix: created.token_prefix }, ip: req.ip });
    // The plaintext token is returned ONCE. The IdP is configured with it and
    // it can never be retrieved again (only revoked + reissued).
    return reply.code(201).send({
      id: created.id,
      token: created.token,
      token_prefix: created.token_prefix,
      scim_base_url: `${req.protocol}://${req.headers.host}/scim/v2`,
      note: 'Store this token now — it will not be shown again.',
    });
  });

  app.delete('/team/scim-tokens/:id', { preHandler: requireCapability('members:manage') }, async (req, reply) => {
    const orgId = req.user!.current_customer_id!;
    const { id } = req.params as { id: string };
    const ok = await revokeScimToken(orgId, id);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    recordAuditSafe({ customerId: orgId, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email, action: 'scim.token_revoked', resource: id, ip: req.ip });
    return { ok: true };
  });
};
