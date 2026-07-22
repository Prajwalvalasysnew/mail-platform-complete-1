import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  db,
  registerOrgWithOwner,
  authenticate,
  recordLogin,
  setPassword,
  issueUserToken,
  consumeUserToken,
  createUserSession,
  revokeUserSession,
  revokeAllUserSessions,
  listUserSessions,
  revokeUserSessionById,
  revokeOtherUserSessions,
  markSessionMfaSatisfied,
  setSessionOrg,
  verifyMfaForUser,
  startTotpEnrollment,
  confirmTotpEnrollment,
  disableMfa,
  recordAuditSafe,
  listMembershipsForUser,
  IdentityError,
  sendEmailVerificationEmail,
  sendPasswordResetEmail,
  isSsoEnforcedForUser,
  getOrgSsoEnforcement,
  setOrgSsoEnforcement,
  issueWebauthnChallenge,
  registerPasskey,
  listPasskeys,
  deletePasskey,
} from '@platform/shared';
import { requireUser, requireFullUser, requireCapability } from '../plugins/session-auth.js';

const bearer = (req: { headers: Record<string, any> }): string =>
  (req.headers.authorization as string | undefined)?.slice(7).trim() ?? '';

// User-level security events are attributed to the user's primary org so they
// surface in that org's activity feed.
async function primaryOrgId(userId: string): Promise<string | null> {
  const m = await listMembershipsForUser(userId);
  return m[0]?.customer_id ?? null;
}

// In production these tokens are emailed, never returned in the API response.
const exposeDevTokens = process.env.NODE_ENV !== 'production';

export const accountRoutes: FastifyPluginAsync = async (app) => {
  // ---- Self-serve registration: user + org + owner membership ----
  const RegisterSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8).max(200),
    name: z.string().min(1).max(100).optional(),
    org_name: z.string().min(1).max(100).optional(),
  });
  app.post('/auth/register', async (req, reply) => {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const { email, password, name, org_name } = parsed.data;

    let user;
    let customerId: string;
    try {
      const result = await registerOrgWithOwner({ email, password, name, orgName: org_name });
      user = result.user;
      customerId = result.customerId;
    } catch (err) {
      if (err instanceof IdentityError) {
        if (err.code === 'email_exists') return reply.code(409).send({ error: 'email_exists' });
        if (err.code === 'org_exists') return reply.code(409).send({ error: 'org_exists', message: 'An organization already uses this email.' });
      }
      throw err;
    }

    recordAuditSafe({ customerId, actorType: 'user', actorId: user.id, actorLabel: user.email, action: 'user.registered', resource: customerId, ip: req.ip });

    const verifyToken = await issueUserToken(user.id, 'email_verify', 60 * 24);
    try {
      await sendEmailVerificationEmail({ to: user.email, token: verifyToken, name: user.name });
    } catch (err) {
      req.log.error({ err, user_id: user.id }, 'failed to send verification email');
    }
    const session = await createUserSession(user.id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      mfaSatisfied: true,
      currentCustomerId: customerId,
    });

    return reply.code(201).send({
      token: session.token,
      expires_at: session.expires_at,
      user: { id: user.id, email: user.email, name: user.name },
      customer_id: customerId,
      ...(exposeDevTokens ? { _dev_email_verify_token: verifyToken } : {}),
    });
  });

  // ---- Login (password) ----
  const LoginSchema = z.object({ email: z.string().email(), password: z.string() });
  app.post('/auth/login', {
    config: {
      rateLimit: {
        hook: 'preHandler',
        max: 10,
        timeWindow: '15 minutes',
        keyGenerator: (req) => {
          const body = req.body as Record<string, unknown> | null;
          const email = typeof body?.email === 'string' ? body.email.toLowerCase() : null;
          return `login:${email ?? req.ip}`;
        },
        errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, error: 'rate_limited', message: `Too many login attempts. Retry in ${Math.ceil(ctx.ttl / 1000)}s.`, retry_after: Math.ceil(ctx.ttl / 1000) }),
      },
    },
  }, async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed' });
    let user;
    try {
      user = await authenticate(parsed.data.email, parsed.data.password);
    } catch (err) {
      if (err instanceof IdentityError && err.code === 'account_locked') {
        const retryAfter = (err as any).retry_after ?? 900;
        reply.header('Retry-After', String(retryAfter));
        return reply.code(429).send({ error: 'account_locked', message: err.message, retry_after: retryAfter });
      }
      throw err;
    }
    if (!user) return reply.code(401).send({ error: 'invalid_credentials' });

    // SSO enforcement: if any of the user's orgs mandate SSO, password login is
    // refused even with correct credentials — they must use the identity
    // provider. Checked only after the password is verified so it can't be used
    // to probe which accounts exist / are SSO-enforced.
    if (await isSsoEnforcedForUser(user.id)) {
      return reply.code(403).send({ error: 'password_login_disabled', message: 'Your organization requires SSO. Sign in through your identity provider.' });
    }

    await recordLogin(user.id);
    recordAuditSafe({ customerId: await primaryOrgId(user.id), actorType: 'user', actorId: user.id, actorLabel: user.email, action: 'user.login', ip: req.ip });
    const session = await createUserSession(user.id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      mfaSatisfied: !user.mfa_enabled,
    });
    return reply.send({
      token: session.token,
      expires_at: session.expires_at,
      mfa_required: user.mfa_enabled,
      user: { id: user.id, email: user.email, name: user.name },
    });
  });

  // ---- MFA challenge (after a password login when mfa_required) ----
  const CodeSchema = z.object({ code: z.string().min(6).max(20) });
  app.post('/auth/mfa', { preHandler: requireUser }, async (req, reply) => {
    const parsed = CodeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed' });
    const ok = await verifyMfaForUser(req.user!.user_id, parsed.data.code);
    if (!ok) return reply.code(401).send({ error: 'invalid_mfa_code' });
    await markSessionMfaSatisfied(req.user!.session_id);
    return { ok: true };
  });

  // ---- Logout ----
  app.post('/auth/logout', { preHandler: requireUser }, async (req) => {
    await revokeUserSession(bearer(req));
    return { ok: true };
  });

  // ---- Active sessions (devices) ----
  // List the caller's active sessions, flagging which one is the current
  // request's session so the UI can label "this device".
  app.get('/auth/sessions', { preHandler: requireFullUser }, async (req) => {
    const sessions = await listUserSessions(req.user!.user_id);
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        current: s.id === req.user!.session_id,
        ip: s.ip,
        user_agent: s.user_agent,
        current_customer_id: s.current_customer_id,
        mfa_satisfied: s.mfa_satisfied,
        last_seen_at: s.last_seen_at,
        created_at: s.created_at,
        expires_at: s.expires_at,
      })),
    };
  });

  // Revoke all sessions except the current one ("log out everywhere else").
  // Declared before the :id route so "revoke-others" is never treated as an id.
  app.post('/auth/sessions/revoke-others', { preHandler: requireFullUser }, async (req) => {
    const revoked = await revokeOtherUserSessions(req.user!.user_id, req.user!.session_id);
    recordAuditSafe({ customerId: req.user!.current_customer_id, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email, action: 'user.sessions_revoked_others', metadata: { revoked }, ip: req.ip });
    return { ok: true, revoked };
  });

  // Revoke one specific session by id (must belong to the caller).
  app.delete('/auth/sessions/:id', { preHandler: requireFullUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await revokeUserSessionById(req.user!.user_id, id);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    recordAuditSafe({ customerId: req.user!.current_customer_id, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email, action: 'user.session_revoked', resource: id, metadata: { self: id === req.user!.session_id }, ip: req.ip });
    return { ok: true };
  });

  // ---- Current user + memberships ----
  app.get('/auth/me', { preHandler: requireFullUser }, async (req) => {
    const u = req.user!;
    return {
      user: { id: u.user_id, email: u.email, name: u.name, mfa_enabled: u.mfa_enabled },
      current_customer_id: u.current_customer_id,
      current_role: u.current_role,
      memberships: u.memberships,
    };
  });

  // ---- Switch active org ----
  const SwitchSchema = z.object({ customer_id: z.string().uuid() });
  app.post('/auth/switch-org', { preHandler: requireFullUser }, async (req, reply) => {
    const parsed = SwitchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed' });
    const ok = await setSessionOrg(req.user!.session_id, req.user!.user_id, parsed.data.customer_id);
    if (!ok) return reply.code(403).send({ error: 'not_a_member' });
    return { ok: true, current_customer_id: parsed.data.customer_id };
  });

  // ---- MFA enrollment ----
  app.post('/auth/mfa/enroll', { preHandler: requireUser }, async (req, reply) => {
    try {
      const enrollment = await startTotpEnrollment(req.user!.user_id, req.user!.email);
      return enrollment; // { factor_id, secret, otpauth_uri }
    } catch (err) {
      if (err instanceof IdentityError) return reply.code(409).send({ error: err.code });
      throw err;
    }
  });

  const ConfirmSchema = z.object({ factor_id: z.string().uuid(), code: z.string().min(6).max(10) });
  app.post('/auth/mfa/confirm', { preHandler: requireUser }, async (req, reply) => {
    const parsed = ConfirmSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed' });
    const result = await confirmTotpEnrollment(req.user!.user_id, parsed.data.factor_id, parsed.data.code);
    if (!result) return reply.code(400).send({ error: 'invalid_code' });
    await markSessionMfaSatisfied(req.user!.session_id);
    recordAuditSafe({ customerId: req.user!.current_customer_id, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email, action: 'user.mfa_enrolled', ip: req.ip });
    return { ok: true, recovery_codes: result.recovery_codes };
  });

  app.post('/auth/mfa/disable', { preHandler: requireFullUser }, async (req) => {
    await disableMfa(req.user!.user_id);
    recordAuditSafe({ customerId: req.user!.current_customer_id, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email, action: 'user.mfa_disabled', ip: req.ip });
    return { ok: true };
  });

  // ---- Organization SSO enforcement (enterprise identity policy) ----
  app.get('/account/settings/sso', { preHandler: requireCapability('settings:manage') }, async (req) => {
    return { sso_enforced: await getOrgSsoEnforcement(req.user!.current_customer_id!) };
  });

  const SsoSchema = z.object({ enforced: z.boolean() });
  app.patch('/account/settings/sso', { preHandler: requireCapability('settings:manage') }, async (req, reply) => {
    const parsed = SsoSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed' });
    await setOrgSsoEnforcement(req.user!.current_customer_id!, parsed.data.enforced);
    recordAuditSafe({ customerId: req.user!.current_customer_id, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email,
      action: parsed.data.enforced ? 'org.sso_enforcement_enabled' : 'org.sso_enforcement_disabled', ip: req.ip });
    return { sso_enforced: parsed.data.enforced };
  });

  // ---- WebAuthn / passkeys (phishing-resistant MFA) ----
  const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID ?? 'localhost';
  const WEBAUTHN_ORIGINS = (process.env.WEBAUTHN_ORIGINS ?? 'http://localhost:3000').split(',').map((o) => o.trim());

  app.post('/account/webauthn/register/options', { preHandler: requireUser }, async (req) => {
    const challenge = await issueWebauthnChallenge(req.user!.user_id, 'register');
    return { challenge, rp: { id: WEBAUTHN_RP_ID }, user: { id: req.user!.user_id, name: req.user!.email }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }] };
  });

  const RegisterPasskeySchema = z.object({
    client_data_json: z.string().min(1), // base64url
    attestation_object: z.string().min(1), // base64url
    name: z.string().max(100).optional(),
  });
  app.post('/account/webauthn/register', { preHandler: requireUser }, async (req, reply) => {
    const parsed = RegisterPasskeySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const result = await registerPasskey({
      userId: req.user!.user_id, rpId: WEBAUTHN_RP_ID, origins: WEBAUTHN_ORIGINS,
      clientDataJSON: Buffer.from(parsed.data.client_data_json, 'base64url'),
      attestationObject: Buffer.from(parsed.data.attestation_object, 'base64url'),
      name: parsed.data.name,
    });
    if (!result.ok) return reply.code(400).send({ error: 'validation_failed', message: result.error });
    recordAuditSafe({ customerId: req.user!.current_customer_id, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email, action: 'user.passkey_registered', resource: result.credentialId, ip: req.ip });
    return reply.code(201).send({ credential_id: result.credentialId });
  });

  app.get('/account/webauthn/credentials', { preHandler: requireUser }, async (req) => {
    return { credentials: await listPasskeys(req.user!.user_id) };
  });

  app.delete<{ Params: { id: string } }>('/account/webauthn/credentials/:id', { preHandler: requireUser }, async (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: 'validation_failed' });
    const ok = await deletePasskey(req.user!.user_id, req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    recordAuditSafe({ customerId: req.user!.current_customer_id, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email, action: 'user.passkey_deleted', resource: req.params.id, ip: req.ip });
    return reply.code(204).send();
  });

  // ---- Password reset ----
  const ForgotSchema = z.object({ email: z.string().email() });
  app.post('/auth/password/forgot', async (req, reply) => {
    const parsed = ForgotSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed' });
    const user = await db.selectFrom('users').select(['id', 'email']).where('email', '=', parsed.data.email.toLowerCase()).executeTakeFirst();
    let devToken: string | undefined;
    if (user) {
      devToken = await issueUserToken(user.id, 'password_reset', 60);
      try {
        await sendPasswordResetEmail({ to: user.email, token: devToken });
      } catch (err) {
        req.log.error({ err, user_id: user.id }, 'failed to send password reset email');
      }
    }
    // Always 200 to avoid revealing whether an account exists.
    return reply.send({ ok: true, ...(exposeDevTokens && devToken ? { _dev_password_reset_token: devToken } : {}) });
  });

  const ResetSchema = z.object({ token: z.string(), password: z.string().min(8).max(200) });
  app.post('/auth/password/reset', async (req, reply) => {
    const parsed = ResetSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed' });
    const consumed = await consumeUserToken('password_reset', parsed.data.token);
    if (!consumed) return reply.code(400).send({ error: 'invalid_or_expired_token' });
    await setPassword(consumed.user_id, parsed.data.password);
    await revokeAllUserSessions(consumed.user_id); // force re-login everywhere
    recordAuditSafe({ customerId: await primaryOrgId(consumed.user_id), actorType: 'user', actorId: consumed.user_id, action: 'user.password_reset', ip: req.ip });
    return { ok: true };
  });

  // ---- Email verification ----
  const VerifySchema = z.object({ token: z.string() });
  app.post('/auth/verify-email', async (req, reply) => {
    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed' });
    const consumed = await consumeUserToken('email_verify', parsed.data.token);
    if (!consumed) return reply.code(400).send({ error: 'invalid_or_expired_token' });

    // The first organization created during self-serve registration uses the
    // owner's email address. Live API keys authenticate against the customer
    // record (rather than the human user record), so carry the same proof of
    // ownership across to matching organizations the user belongs to. Without
    // this, the owner can verify successfully in the console but every live
    // send remains permanently blocked as `email_not_verified`.
    const user = await db.selectFrom('users')
      .select('email')
      .where('id', '=', consumed.user_id)
      .executeTakeFirst();
    const memberships = await db.selectFrom('memberships')
      .select('customer_id')
      .where('user_id', '=', consumed.user_id)
      .execute();
    const customerIds = memberships.map((membership) => membership.customer_id);
    if (user && customerIds.length > 0) {
      await db.updateTable('customers')
        .set({ email_verified_at: new Date() })
        .where('id', 'in', customerIds)
        .where('email', '=', user.email)
        .where('email_verified_at', 'is', null)
        .execute();
    }
    return { ok: true };
  });

  // ---- Resend email verification ----
  // Re-issues a verification token for the currently authenticated user.
  // Useful when the original email was lost or the 24-hour token expired.
  app.post('/auth/resend-verification', { preHandler: requireUser }, async (req, reply) => {
    const user = req.user!;
    const row = await db
      .selectFrom('users')
      .select(['id', 'email', 'name', 'email_verified_at'])
      .where('id', '=', user.user_id)
      .executeTakeFirst();

    if (!row) return reply.code(404).send({ error: 'not_found' });
    // Already verified — nothing to do.
    if (row.email_verified_at) return { ok: true, already_verified: true };

    const verifyToken = await issueUserToken(user.user_id, 'email_verify', 60 * 24);
    try {
      await sendEmailVerificationEmail({ to: row.email, token: verifyToken, name: row.name });
    } catch (err) {
      req.log.error({ err, user_id: user.user_id }, 'failed to resend email verification');
    }

    return { ok: true, ...(exposeDevTokens ? { _dev_email_verify_token: verifyToken } : {}) };
  });
};
