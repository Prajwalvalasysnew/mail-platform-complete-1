import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { db, generateApiKeyV2, sendApiSignupVerificationEmail } from '@platform/shared';

/** Constant-time string compare that fails closed if either side is empty. */
function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function hashVerifyToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// In production tokens are emailed, never returned in the API response.
const exposeDevTokens = process.env.NODE_ENV !== 'production';

const SignupSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100).optional(),
});

const CreateKeySchema = z.object({
  customer_id: z.string().uuid(),
  admin_token: z.string(),
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).optional(),
  key_type: z.enum(['secret', 'test', 'publishable']).optional(),
});

export const customerRoutes: FastifyPluginAsync = async (app) => {
  // ---- Public signup: creates customer + initial API key ----
  // Email ownership must be confirmed before the customer can send (see send.ts).
  // A verification link is emailed immediately; token expires after 24 hours.
  app.post('/signup', async (req, reply) => {
    const parsed = SignupSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    }

    try {
      const customer = await db
        .insertInto('customers')
        .values({
          email: parsed.data.email.toLowerCase(),
          name: parsed.data.name ?? null,
        })
        .returning(['id', 'email', 'tier', 'daily_quota'])
        .executeTakeFirstOrThrow();

      const apiKey = generateApiKeyV2('secret');
      await db
        .insertInto('api_keys')
        .values({
          customer_id: customer.id,
          name: 'default',
          key_prefix: apiKey.prefix,
          key_hash: apiKey.hash,
          key_type: apiKey.key_type,
          scopes: ['send', 'domains', 'suppressions', 'messages', 'webhooks', 'templates'],
        })
        .execute();

      // Issue a 24-hour email verification token.
      const verifyToken = crypto.randomBytes(32).toString('base64url');
      const tokenExpiry = new Date(Date.now() + 24 * 3600_000);
      await db
        .updateTable('customers')
        .set({
          email_verify_token_hash: hashVerifyToken(verifyToken),
          email_verify_token_expires_at: tokenExpiry,
        })
        .where('id', '=', customer.id)
        .execute();

      try {
        await sendApiSignupVerificationEmail({ to: customer.email, token: verifyToken });
      } catch (err) {
        req.log.error({ err, customer_id: customer.id }, 'failed to send signup verification email');
      }

      return reply.code(201).send({
        customer,
        api_key: apiKey.plaintext,
        note: 'Save this API key — it will not be shown again. Verify your email to unlock sending.',
        email_verified: false,
        ...(exposeDevTokens ? { _dev_email_verify_token: verifyToken } : {}),
      });
    } catch (err: any) {
      if (err.code === '23505') {
        return reply.code(409).send({ error: 'email_exists' });
      }
      throw err;
    }
  });

  // ---- POST /v1/verify-email ----
  // Consumes a signup verification token, marks the customer's email as verified.
  // Idempotent: calling it again after successful verification returns 200.
  const VerifySchema = z.object({ token: z.string().min(1) });
  app.post('/verify-email', async (req, reply) => {
    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed' });

    const tokenHash = hashVerifyToken(parsed.data.token);
    const customer = await db
      .selectFrom('customers')
      .select(['id', 'email_verified_at', 'email_verify_token_expires_at'])
      .where('email_verify_token_hash', '=', tokenHash)
      .executeTakeFirst();

    if (!customer) return reply.code(400).send({ error: 'invalid_or_expired_token' });
    if (customer.email_verify_token_expires_at && new Date(customer.email_verify_token_expires_at) < new Date()) {
      return reply.code(400).send({
        error: 'token_expired',
        message: 'Verification token has expired. Call POST /v1/resend-verification to get a new one.',
      });
    }

    await db
      .updateTable('customers')
      .set({
        email_verified_at: new Date(),
        email_verify_token_hash: null,
        email_verify_token_expires_at: null,
      })
      .where('id', '=', customer.id)
      .execute();

    return { ok: true };
  });

  // ---- POST /v1/resend-verification ----
  // Re-issues a verification token for a customer who didn't receive or whose
  // token expired. Always returns 200 to avoid revealing whether an account exists.
  const ResendSchema = z.object({ email: z.string().email() });
  app.post('/resend-verification', async (req, reply) => {
    const parsed = ResendSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed' });

    const customer = await db
      .selectFrom('customers')
      .select(['id', 'email', 'email_verified_at'])
      .where('email', '=', parsed.data.email.toLowerCase())
      .executeTakeFirst();

    // Return 200 regardless of whether the account exists to avoid enumeration.
    if (!customer || customer.email_verified_at) {
      return { ok: true };
    }

    const verifyToken = crypto.randomBytes(32).toString('base64url');
    const tokenExpiry = new Date(Date.now() + 24 * 3600_000);
    await db
      .updateTable('customers')
      .set({
        email_verify_token_hash: hashVerifyToken(verifyToken),
        email_verify_token_expires_at: tokenExpiry,
      })
      .where('id', '=', customer.id)
      .execute();

    try {
      await sendApiSignupVerificationEmail({ to: customer.email, token: verifyToken });
    } catch (err) {
      req.log.error({ err, customer_id: customer.id }, 'failed to resend verification email');
    }

    return { ok: true, ...(exposeDevTokens ? { _dev_email_verify_token: verifyToken } : {}) };
  });

  // ---- Customer profile (GET/PATCH /v1/profile) lives in routes/profile.ts.
  // It must be registered INSIDE the API-key auth scope (it depends on
  // req.auth), so it can't live here in the public customers plugin.

  // ---- Admin: create additional API keys ----
  app.post('/admin/api-keys', async (req, reply) => {
    const parsed = CreateKeySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    }
    if (!safeEqual(parsed.data.admin_token, process.env.ADMIN_TOKEN)) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    const keyType = parsed.data.key_type ?? 'secret';
    const apiKey = generateApiKeyV2(keyType);
    const row = await db
      .insertInto('api_keys')
      .values({
        customer_id: parsed.data.customer_id,
        name: parsed.data.name,
        key_prefix: apiKey.prefix,
        key_hash: apiKey.hash,
        key_type: apiKey.key_type,
        scopes: parsed.data.scopes ?? ['send'],
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    return reply.code(201).send({ id: row.id, api_key: apiKey.plaintext });
  });
};
