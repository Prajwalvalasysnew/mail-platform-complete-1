import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import {
  resolveScimToken,
  scimCreateUser,
  scimGetUser,
  scimListUsers,
  scimPatchUser,
  scimReplaceUser,
  scimDeleteUser,
  ScimError,
  SCIM_ERROR_SCHEMA,
} from '@platform/shared';

// SCIM 2.0 (RFC 7644) provisioning endpoints for enterprise customer tenants.
// The IdP authenticates with a per-tenant bearer token (Authorization: Bearer
// <scim token>) minted via the account API. All routes are scoped to the tenant
// the token resolves to.

declare module 'fastify' {
  interface FastifyRequest {
    scimCustomerId?: string;
  }
}

function scimErrorBody(status: number, detail: string, scimType?: string) {
  return { schemas: [SCIM_ERROR_SCHEMA], status: String(status), scimType, detail };
}

function baseUrlOf(req: FastifyRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string) ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

export const scimRoutes: FastifyPluginAsync = async (app) => {
  // Bearer-token auth for the whole SCIM surface.
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.headers.authorization;
    const token = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : undefined;
    const resolved = await resolveScimToken(token);
    if (!resolved) {
      return reply.code(401)
        .header('content-type', 'application/scim+json')
        .send(scimErrorBody(401, 'Invalid or missing SCIM bearer token'));
    }
    req.scimCustomerId = resolved.customerId;
  });

  // Uniform SCIM error/JSON content type on responses.
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.getHeader('content-type')) reply.header('content-type', 'application/scim+json');
    return payload;
  });

  const handle = async (reply: FastifyReply, fn: () => Promise<unknown>, okCode = 200) => {
    try {
      const result = await fn();
      return reply.code(okCode).send(result);
    } catch (err) {
      if (err instanceof ScimError) {
        return reply.code(err.status).send(scimErrorBody(err.status, err.message, err.scimType));
      }
      throw err;
    }
  };

  // ServiceProviderConfig — IdPs probe this to discover capabilities.
  app.get('/scim/v2/ServiceProviderConfig', async (_req, reply) => {
    return reply.send({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer Token', description: 'Per-tenant SCIM bearer token' }],
    });
  });

  app.get('/scim/v2/Users', async (req, reply) => {
    const { filter, startIndex, count } = req.query as Record<string, string>;
    return handle(reply, () => scimListUsers(req.scimCustomerId!, {
      filter,
      startIndex: startIndex ? parseInt(startIndex, 10) : undefined,
      count: count ? parseInt(count, 10) : undefined,
    }, baseUrlOf(req)));
  });

  app.get('/scim/v2/Users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return handle(reply, () => scimGetUser(req.scimCustomerId!, id, baseUrlOf(req)));
  });

  app.post('/scim/v2/Users', async (req, reply) => {
    return handle(reply, () => scimCreateUser(req.scimCustomerId!, req.body as any, baseUrlOf(req)), 201);
  });

  app.patch('/scim/v2/Users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return handle(reply, () => scimPatchUser(req.scimCustomerId!, id, req.body as any, baseUrlOf(req)));
  });

  app.put('/scim/v2/Users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return handle(reply, () => scimReplaceUser(req.scimCustomerId!, id, req.body as any, baseUrlOf(req)));
  });

  app.delete('/scim/v2/Users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await scimDeleteUser(req.scimCustomerId!, id);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof ScimError) {
        return reply.code(err.status).send(scimErrorBody(err.status, err.message, err.scimType));
      }
      throw err;
    }
  });
};
