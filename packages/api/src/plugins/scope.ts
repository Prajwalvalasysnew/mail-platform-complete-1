import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Returns a preHandler that requires the API key to have the given scope.
 * Use as: { preHandler: requireScope('send') }
 */
export function requireScope(scope: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.auth;
    if (!auth) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    // 'admin' scope grants everything
    if (auth.scopes.includes('admin') || auth.scopes.includes(scope)) {
      return;
    }
    return reply.code(403).send({
      error: 'insufficient_scope',
      message: `This API key lacks the '${scope}' scope.`,
    });
  };
}
