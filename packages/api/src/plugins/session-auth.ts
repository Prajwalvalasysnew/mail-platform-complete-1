import type { FastifyRequest, FastifyReply } from 'fastify';
import { resolveUserSession, roleHasCapability, type UserSessionContext, type Capability } from '@platform/shared';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserSessionContext;
  }
}

/** Resolve + cache the user session from the Bearer token (no-op if absent). */
async function load(req: FastifyRequest): Promise<UserSessionContext | null> {
  if (req.user) return req.user;
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const ctx = await resolveUserSession(header.slice(7).trim());
  if (ctx) req.user = ctx;
  return ctx;
}

/** Requires a valid session. Used for the MFA challenge step (pre-MFA). */
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const ctx = await load(req);
  if (!ctx) return reply.code(401).send({ error: 'authentication_required' });
}

/** Requires a valid session that has also satisfied MFA (if the user has it). */
export async function requireFullUser(req: FastifyRequest, reply: FastifyReply) {
  const ctx = await load(req);
  if (!ctx) return reply.code(401).send({ error: 'authentication_required' });
  if (ctx.mfa_enabled && !ctx.mfa_satisfied) {
    return reply.code(403).send({ error: 'mfa_required', message: 'Complete the MFA challenge to continue.' });
  }
}

/** Requires a full session whose active-org role grants the given capability. */
export function requireCapability(cap: Capability) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = await load(req);
    if (!ctx) return reply.code(401).send({ error: 'authentication_required' });
    if (ctx.mfa_enabled && !ctx.mfa_satisfied) {
      return reply.code(403).send({ error: 'mfa_required' });
    }
    if (!ctx.current_customer_id || !ctx.current_role) {
      return reply.code(403).send({ error: 'no_active_org', message: 'Select an organization first.' });
    }
    if (!roleHasCapability(ctx.current_role, cap)) {
      return reply.code(403).send({ error: 'insufficient_role', message: `Requires capability '${cap}'.` });
    }
  };
}
