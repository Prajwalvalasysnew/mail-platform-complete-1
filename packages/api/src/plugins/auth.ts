import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { db, redis, verifyApiKeyV2, detectKeyType, apiKeyVerifyDuration, type AuthContext } from '@platform/shared';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const authPluginImpl: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req, reply) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing_auth', message: 'Bearer token required' });
    }

    const token = header.slice('Bearer '.length).trim();
    const keyType = detectKeyType(token);
    if (!keyType) {
      return reply.code(401).send({ error: 'invalid_key', message: 'Invalid API key format' });
    }

    const prefix = token.slice(0, 12);
    const candidates = await db
      .selectFrom('api_keys')
      .innerJoin('customers', 'customers.id', 'api_keys.customer_id')
      .select([
        'api_keys.id as api_key_id',
        'api_keys.customer_id',
        'api_keys.key_hash',
        'api_keys.scopes',
        'api_keys.key_type',
        'api_keys.revoked_at',
        'api_keys.expires_at',
        'customers.tier',
        'customers.status',
        'customers.email_verified_at',
      ])
      .where('api_keys.key_prefix', '=', prefix)
      .where('api_keys.revoked_at', 'is', null)
      .execute();

    const timer = apiKeyVerifyDuration.startTimer();
    let matched: typeof candidates[number] | undefined;
    for (const cand of candidates) {
      if (await verifyApiKeyV2(token, cand.key_hash)) {
        matched = cand;
        break;
      }
    }
    timer();

    if (!matched) {
      return reply.code(401).send({ error: 'invalid_key', message: 'API key not recognized' });
    }
    if (matched.status !== 'active') {
      return reply.code(403).send({ error: 'account_suspended', message: 'Account is not active' });
    }
    if (matched.expires_at && new Date(matched.expires_at) < new Date()) {
      return reply.code(401).send({ error: 'expired_key', message: 'API key has expired' });
    }

    // Update last-used in the background, but at most once per 60s per key to
    // avoid a DB write on every single request (write amplification + row-lock
    // contention on hot keys at scale). A Redis SET NX EX is the cheap gate: the
    // first request in each 60s window wins and does the write; the rest skip it.
    void (async () => {
      try {
        const gate = await redis.set(`apikey:lastused:${matched.api_key_id}`, '1', 'EX', 60, 'NX');
        if (gate === 'OK') {
          await db.updateTable('api_keys')
            .set({ last_used_at: new Date() })
            .where('id', '=', matched.api_key_id)
            .execute();
        }
      } catch (err) {
        app.log.warn({ err }, 'failed to update last_used_at');
      }
    })();

    req.auth = {
      api_key_id: matched.api_key_id,
      customer_id: matched.customer_id,
      tier: matched.tier,
      scopes: matched.scopes,
      // Test keys route to a sandbox transport (no real delivery) downstream.
      test_mode: matched.key_type === 'test',
      email_verified: matched.email_verified_at != null,
    };
  });
};

export const authPlugin = fp(authPluginImpl, { name: 'auth' });
