import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { startCheckout, startBillingPortal, getBillingOverview, recordAuditSafe } from '@platform/shared';
import { requireCapability } from '../plugins/session-auth.js';

// Customer-facing billing under /v1/account/billing. All routes require the
// billing:manage capability (owner + billing roles). The actual provider calls
// go through the BillingProvider seam (mock by default, Stripe in production).
export const accountBillingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/account/billing', { preHandler: requireCapability('billing:manage') }, async (req, reply) => {
    const overview = await getBillingOverview(req.user!.current_customer_id!);
    if (!overview) return reply.code(404).send({ error: 'not_found' });
    return overview;
  });

  const CheckoutSchema = z.object({
    price_id: z.string().min(1).max(200),
    success_url: z.string().url(),
    cancel_url: z.string().url(),
  });
  app.post('/account/billing/checkout', { preHandler: requireCapability('billing:manage') }, async (req, reply) => {
    const parsed = CheckoutSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const session = await startCheckout({
      customerId: req.user!.current_customer_id!,
      priceId: parsed.data.price_id,
      successUrl: parsed.data.success_url,
      cancelUrl: parsed.data.cancel_url,
    });
    recordAuditSafe({
      customerId: req.user!.current_customer_id,
      actorType: 'user',
      actorId: req.user!.user_id,
      actorLabel: req.user!.email,
      action: 'billing.checkout_started',
      resource: parsed.data.price_id,
      metadata: { session_id: session.id },
      ip: req.ip,
    });
    return reply.code(201).send({ id: session.id, url: session.url });
  });

  const PortalSchema = z.object({ return_url: z.string().url() });
  app.post('/account/billing/portal', { preHandler: requireCapability('billing:manage') }, async (req, reply) => {
    const parsed = PortalSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const session = await startBillingPortal({ customerId: req.user!.current_customer_id!, returnUrl: parsed.data.return_url });
    return { url: session.url };
  });
};
