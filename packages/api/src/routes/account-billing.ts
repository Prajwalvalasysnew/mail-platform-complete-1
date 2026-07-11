import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { startCheckout, startBillingPortal, getBillingOverview, getCustomerInvoice, listCustomerInvoices, listCustomerCreditNotes, previewPlanChange, confirmPlanChange, cancelPlanChange, recordAuditSafe, isCheckoutPriceAvailable } from '@platform/shared';
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
    // Never forward an arbitrary caller-supplied provider price to checkout.
    // isKnownPrice accepts only the internal catalog keys or explicitly mapped
    // live provider prices, so retired/foreign prices fail before billing I/O.
    if (!await isCheckoutPriceAvailable(req.user!.current_customer_id!, parsed.data.price_id)) {
      return reply.code(422).send({ error: 'unknown_price', message: 'The requested plan is not available.' });
    }
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

  const InvoiceListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), before: z.string().datetime().optional() });
  app.get('/account/billing/invoices', { preHandler: requireCapability('billing:manage') }, async (req, reply) => {
    const parsed = InvoiceListQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    return listCustomerInvoices(req.user!.current_customer_id!, parsed.data);
  });

  app.get('/account/billing/credit-notes', { preHandler: requireCapability('billing:manage') }, async (req, reply) => {
    const parsed = InvoiceListQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    return listCustomerCreditNotes(req.user!.current_customer_id!, parsed.data);
  });

  app.get<{ Params: { id: string } }>('/account/billing/invoices/:id', { preHandler: requireCapability('billing:manage') }, async (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: 'validation_failed' });
    const invoice = await getCustomerInvoice(req.user!.current_customer_id!, req.params.id);
    if (!invoice) return reply.code(404).send({ error: 'not_found' });
    return invoice;
  });

  const PlanChangePreview = z.object({ price_id: z.string().min(1).max(200) });
  app.post('/account/billing/plan-change/preview', { preHandler: requireCapability('billing:manage') }, async (req, reply) => {
    const parsed = PlanChangePreview.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    try {
      const preview = await previewPlanChange(req.user!.current_customer_id!, parsed.data.price_id);
      recordAuditSafe({ customerId: req.user!.current_customer_id, actorType: 'user', actorId: req.user!.user_id,
        action: 'billing.plan_change_previewed', resource: preview.request_id, metadata: { target_plan: preview.target_plan, direction: preview.direction }, ip: req.ip });
      return preview;
    } catch (error) {
      if (error instanceof Error && error.message === 'unknown_price') return reply.code(422).send({ error: 'unknown_price' });
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/account/billing/plan-change/:id/confirm', { preHandler: requireCapability('billing:manage') }, async (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: 'validation_failed' });
    const result = await confirmPlanChange(req.user!.current_customer_id!, req.params.id);
    if (result.status === 'not_found') return reply.code(404).send({ error: 'not_found' });
    // A downgrade is scheduled at period end rather than submitted immediately;
    // that is a successful outcome, not a conflict.
    if (result.status === 'scheduled') {
      recordAuditSafe({ customerId: req.user!.current_customer_id, actorType: 'user', actorId: req.user!.user_id,
        action: 'billing.plan_change_scheduled', resource: req.params.id, metadata: { effective_at: result.effective_at }, ip: req.ip });
      return reply.code(202).send(result);
    }
    if (result.status !== 'pending_provider_confirmation') return reply.code(409).send({ error: result.status });
    recordAuditSafe({ customerId: req.user!.current_customer_id, actorType: 'user', actorId: req.user!.user_id,
      action: 'billing.plan_change_submitted', resource: req.params.id, metadata: { provider_status: result.provider_status }, ip: req.ip });
    return reply.code(202).send(result);
  });

  app.delete<{ Params: { id: string } }>('/account/billing/plan-change/:id', { preHandler: requireCapability('billing:manage') }, async (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: 'validation_failed' });
    const result = await cancelPlanChange(req.user!.current_customer_id!, req.params.id);
    if (result === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (result === 'not_cancelable') return reply.code(409).send({ error: 'not_cancelable' });
    return reply.code(204).send();
  });
};
