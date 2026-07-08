import type { FastifyPluginAsync } from 'fastify';
import { listCustomerAudit, normalizeAuditQuery, verifyAuditChain } from '@platform/shared';
import { requireCapability } from '../plugins/session-auth.js';

export const auditRoutes: FastifyPluginAsync = async (app) => {
  // Account activity log for the active org. Read-only; any role with the
  // logs:read capability (analyst and up) can view it. Newest-first, paginated
  // by `before` cursor; filter by `action`, `actor_type`, and `days`.
  app.get('/account/audit', { preHandler: requireCapability('logs:read') }, async (req) => {
    const q = normalizeAuditQuery(req.query as Record<string, string>);
    return listCustomerAudit(req.user!.current_customer_id!, q);
  });

  // Tamper-evidence check (gap analysis #10): re-walk this org's audit hash
  // chain and report whether it is intact. Restricted to members:manage
  // (org admins) since it exposes integrity state of the whole log.
  app.get('/account/audit/verify', { preHandler: requireCapability('members:manage') }, async (req) => {
    const result = await verifyAuditChain(req.user!.current_customer_id!);
    return result;
  });
};
