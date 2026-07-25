import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  appendSupportTicketMessage,
  countUnreadSupportTickets,
  createSupportTicket,
  getSupportTicket,
  listCustomerSupportTickets,
  markSupportTicketRead,
  normalizeSupportTicketQuery,
  rateSupportTicket,
  recordAuditSafe,
  redactCardData,
  summarizeFindings,
} from '@platform/shared';
import { requireCapability } from '../plugins/session-auth.js';

// PCI-02: support tickets are a classic accidental card-data channel — a
// customer troubleshooting a payment pastes the number they were looking at.
//
// This ingress always REDACTS rather than blocks, whatever CARD_DATA_POLICY
// says. Rejecting the ticket would throw away a customer's help request and
// train them to work around the check (screenshot, second ticket, email to an
// agent) — which puts the same data somewhere with less scrubbing. Redacting
// on the way in means the value never reaches support_tickets, the agent
// console, or a backup.
function scrubTicketText(fields: { subject?: string; body: string }, log: { warn: (o: object, m: string) => void }) {
  const subject = fields.subject === undefined ? undefined : redactCardData(fields.subject, 'subject');
  const body = redactCardData(fields.body, 'body');
  const findings = [...(subject?.findings ?? []), ...body.findings];
  if (findings.length > 0) {
    log.warn({ ...summarizeFindings(findings) }, '[pci] card data redacted from support ticket content');
  }
  return { subject: subject?.text, body: body.text, findings };
}

export const supportRoutes: FastifyPluginAsync = async (app) => {
  app.get('/support/tickets', { preHandler: requireCapability('logs:read') }, async (req) => {
    const user = req.user!;
    const query = normalizeSupportTicketQuery(req.query as Record<string, string>);
    return listCustomerSupportTickets(user.current_customer_id!, query);
  });

  app.get('/support/tickets/unread-count', { preHandler: requireCapability('logs:read') }, async (req) => {
    const user = req.user!;
    return {
      unread: await countUnreadSupportTickets({
        viewerType: 'customer_user',
        viewerUserId: user.user_id,
        customerId: user.current_customer_id!,
      }),
    };
  });

  const CreateSchema = z.object({
    subject: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(10000),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    category: z.enum(['general', 'billing', 'deliverability', 'technical', 'abuse', 'account']).optional(),
  });

  app.post('/support/tickets', { preHandler: requireCapability('logs:read') }, async (req, reply) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const user = req.user!;
    const scrubbed = scrubTicketText({ subject: parsed.data.subject, body: parsed.data.body }, req.log); // PCI-02
    const ticket = await createSupportTicket({
      customerId: user.current_customer_id!,
      subject: scrubbed.subject!,
      body: scrubbed.body,
      priority: parsed.data.priority,
      category: parsed.data.category,
      createdByUserId: user.user_id,
    });
    await markSupportTicketRead({
      ticketId: ticket.id,
      viewerType: 'customer_user',
      viewerUserId: user.user_id,
      customerId: user.current_customer_id!,
    });
    recordAuditSafe({
      customerId: user.current_customer_id,
      actorType: 'user',
      actorId: user.user_id,
      actorLabel: user.email,
      action: 'support.ticket_created',
      resource: ticket.id,
      metadata: { priority: ticket.priority, category: ticket.category },
      ip: req.ip,
    });
    return reply.code(201).send({ ticket });
  });

  app.get('/support/tickets/:id', { preHandler: requireCapability('logs:read') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = await getSupportTicket(id, { customerId: req.user!.current_customer_id!, includeInternal: false });
    if (!detail) return reply.code(404).send({ error: 'not_found' });
    return detail;
  });

  app.post('/support/tickets/:id/read', { preHandler: requireCapability('logs:read') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await markSupportTicketRead({
      ticketId: id,
      viewerType: 'customer_user',
      viewerUserId: req.user!.user_id,
      customerId: req.user!.current_customer_id!,
    });
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { ok: true, last_read_at: row.last_read_at };
  });

  const MessageSchema = z.object({ body: z.string().trim().min(1).max(10000) });
  app.post('/support/tickets/:id/messages', { preHandler: requireCapability('logs:read') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = MessageSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const user = req.user!;
    const msg = await appendSupportTicketMessage({
      ticketId: id,
      customerId: user.current_customer_id!,
      userId: user.user_id,
      body: scrubTicketText({ body: parsed.data.body }, req.log).body, // PCI-02
    });
    if (!msg) return reply.code(404).send({ error: 'not_found' });
    await markSupportTicketRead({
      ticketId: id,
      viewerType: 'customer_user',
      viewerUserId: user.user_id,
      customerId: user.current_customer_id!,
    });
    recordAuditSafe({
      customerId: user.current_customer_id,
      actorType: 'user',
      actorId: user.user_id,
      actorLabel: user.email,
      action: 'support.ticket_replied',
      resource: id,
      metadata: { message_id: msg.id },
      ip: req.ip,
    });
    return reply.code(201).send({ message: msg });
  });

  // CSAT: rate a resolved/closed ticket (1-5 + optional comment).
  const RateSchema = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(2000).optional() });
  app.post('/support/tickets/:id/rate', { preHandler: requireCapability('logs:read') }, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const parsed = RateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const result = await rateSupportTicket({
      ticketId: id,
      customerId: user.current_customer_id!,
      rating: parsed.data.rating,
      comment: parsed.data.comment ?? null,
    });
    if ('error' in result) {
      return reply.code(result.error === 'not_found' ? 404 : 409).send({ error: result.error });
    }
    recordAuditSafe({
      customerId: user.current_customer_id,
      actorType: 'user',
      actorId: user.user_id,
      actorLabel: user.email,
      action: 'support.ticket_rated',
      resource: id,
      metadata: { rating: parsed.data.rating },
      ip: req.ip,
    });
    return { ok: true };
  });
};
