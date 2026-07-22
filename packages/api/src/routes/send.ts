import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  db,
  sendQueue,
  generateMessageId,
  isSuppressed,
  isSuppressedBatch,
  scanContent,
  classify,
  isTrapOrDisposable,
  isTrapOrDisposableBatch,
  checkVolumeAnomaly,
  canSendOnPool,
  poolAction,
  reserveQuota,
  releaseQuota,
  getCustomerQueueDepth,
  incrementQueueDepth,
  renderTemplate,
  MissingTemplateVariablesError,
  messagesAccepted,
  messagesBlocked,
  backpressureRejections,
  hashRequestBody,
  reserveIdempotencyKey,
  recordIdempotentResponse,
  createSendOutboxRows,
  drainSendOutbox,
  resolveSendLane,
  validateAttachments,
  scanAttachmentsForMalware,
  checkQuotaThresholds,
  sendQuotaWarningEmail,
  injectTraceContext,
  type SendResponse,
  getBodyStore,
  evaluateBillingAccess,
} from '@platform/shared';
import { requireScope } from '../plugins/scope.js';
import { tenantScoped } from '../lib/tenant.js';

const BACKPRESSURE_THRESHOLD = Number(process.env.SEND_QUEUE_BACKPRESSURE ?? 100_000);

const SendSchema = z.object({
  from: z.string().email(),
  from_name: z.string().max(100).optional(),
  to: z.union([z.string().email(), z.array(z.string().email()).min(1).max(1000)]),
  reply_to: z.string().email().optional(),
  subject: z.string().max(998).optional(),
  // Cap inline bodies. The ingress allows 10MB total, but per-field limits stop
  // a single pathological body from driving render/DB cost and protect multi-
  // tenant fairness. ~1MB of HTML is already very large for an email.
  html: z.string().max(1_048_576, 'html body exceeds 1MB limit').optional(),
  text: z.string().max(1_048_576, 'text body exceeds 1MB limit').optional(),
  template_id: z.string().uuid().optional(),
  variables: z.record(z.unknown()).optional(),
  // When true, reject the send (422) if the template references any variable
  // not supplied in `variables`, instead of silently rendering it as an empty
  // string. Opt-in so existing integrations are unaffected; defaults to the
  // historical lenient behavior. Only meaningful with template_id.
  require_all_variables: z.boolean().optional(),
  headers: z
    .record(
      z.string().regex(/^[a-zA-Z0-9\-]+$/, 'header name must be alphanumeric/hyphen only').max(64),
      z.string().max(2048, 'individual header value too long')
    )
    .optional()
    .refine((h) => !h || Object.keys(h).length <= 50, 'maximum 50 custom headers')
    .refine(
      (h) => !h || JSON.stringify(h).length <= 102400,
      'total header block exceeds 100 KB'
    ),
  tags: z.array(z.string().max(50)).max(10).optional(),
  metadata: z.record(z.unknown()).optional(),
  tracking: z.object({ opens: z.boolean().default(true), clicks: z.boolean().default(true) }).optional(),
  ip_pool: z.enum(['transactional', 'marketing', 'quarantine']).optional(),
  // CANSPAM-01: legal message classification. Defaults to 'commercial' (the
  // safe class — full CAN-SPAM treatment). Declaring 'transactional' or
  // 'relationship' requires the 'classify' scope and is audit-logged.
  message_class: z.enum(['transactional', 'relationship', 'commercial']).optional(),
  send_at: z.string().datetime().optional(),
  unsubscribe_group_id: z.string().uuid().optional(),
  // 'critical' puts the message at the head of the queue (OTPs, fraud/outage
  // alerts). Paid/enterprise tiers only; per-minute capped — overflow is
  // downgraded to the standard lane, reported via priority_applied.
  priority: z.enum(['normal', 'critical']).optional(),
  // Base64 file attachments (invoices, reports). Executable types are
  // refused; size limits enforced in validateAttachments.
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(255),
        content: z.string().min(1).max(10_000_000),
        content_type: z.string().max(120).optional(),
      })
    )
    .max(10)
    .optional(),
});

export const sendRoutes: FastifyPluginAsync = async (app) => {
  // Idempotency: replay stored responses and capture new ones. The Idempotency-Key
  // header is optional; when absent these hooks are no-ops. We attach the reserved
  // key to the request so the onSend hook can persist the final response.
  app.post(
    '/send',
    {
      config: {
        // Heavier per-endpoint cap: sending is far more expensive than listing.
        rateLimit: {
          max: Number(process.env.SEND_RATE_LIMIT_PER_MINUTE ?? 300),
          timeWindow: '1 minute',
        },
      },
      preHandler: [
        requireScope('send'),
        async (req, reply) => {
          const key = (req.headers['idempotency-key'] as string | undefined)?.trim();
          if (!key) return;
          if (key.length > 255) {
            return reply.code(400).send({ error: 'invalid_idempotency_key', message: 'Idempotency-Key too long' });
          }
          const auth = req.auth!;
          const requestHash = hashRequestBody(req.body);
          const lookup = await reserveIdempotencyKey(auth.customer_id, key, requestHash);
          if (lookup.kind === 'replay') {
            reply.header('Idempotent-Replayed', 'true');
            return reply.code(lookup.status_code).send(lookup.response_body);
          }
          if (lookup.kind === 'conflict') {
            return reply.code(422).send({
              error: 'idempotency_key_reused',
              message: 'This Idempotency-Key was already used with a different request body.',
            });
          }
          if (lookup.kind === 'in_progress') {
            reply.header('Retry-After', '2');
            return reply.code(409).send({
              error: 'idempotency_in_progress',
              message: 'A request with this Idempotency-Key is still being processed. Retry shortly.',
            });
          }
          // kind === 'proceed' — remember the key so onSend can record the result.
          (req as any).idempotencyKey = key;
        },
      ],
    },
    async (req, reply) => {
    const auth = req.auth!;

    // Backpressure: if the send queue is deeply backed up, shed load with a 503
    // + Retry-After rather than accepting unbounded work we can't drain.
    try {
      const counts = await sendQueue.getJobCounts('waiting', 'delayed');
      const depth = (counts.waiting ?? 0) + (counts.delayed ?? 0);
      if (depth > BACKPRESSURE_THRESHOLD) {
        backpressureRejections.inc();
        reply.header('Retry-After', '30');
        return reply.code(503).send({
          error: 'backpressure',
          message: 'The send queue is saturated. Retry shortly.',
        });
      }
    } catch {
      /* if we can't read the queue, fail open and proceed */
    }

    const parsed = SendSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    }
    const body = parsed.data;

    // CANSPAM-01: only keys holding the 'classify' scope may declare a
    // non-commercial class; everyone else gets the safe default. Rejected
    // loudly (not silently downgraded) so misclassification attempts are
    // visible to the integrator and in the audit trail.
    const messageClass = body.message_class ?? 'commercial';
    if (messageClass !== 'commercial' && !auth.scopes.includes('classify') && !auth.scopes.includes('admin')) {
      return reply.code(403).send({
        error: 'classification_not_authorized',
        message: `Declaring message_class '${messageClass}' requires the 'classify' scope.`,
      });
    }

    // Resolve content — either inline or from a template
    let subject = body.subject;
    let html = body.html;
    let text = body.text;
    let templateId: string | null = null;

    if (body.template_id) {
      const tpl = await tenantScoped(req, (trx) =>
        trx
          .selectFrom('templates')
          .selectAll()
          .where('id', '=', body.template_id!)
          .where('customer_id', '=', auth.customer_id)
          .executeTakeFirst()
      );
      if (!tpl) return reply.code(404).send({ error: 'template_not_found' });
      let rendered;
      try {
        rendered = renderTemplate(tpl, body.variables ?? {}, {
          onMissing: body.require_all_variables ? 'error' : 'ignore',
        });
      } catch (err) {
        if (err instanceof MissingTemplateVariablesError) {
          return reply.code(422).send({ error: 'missing_template_variables', missing: err.missing });
        }
        throw err;
      }
      subject = rendered.subject;
      html = rendered.html;
      text = rendered.text;
      templateId = tpl.id;
    }

    if (!subject) return reply.code(400).send({ error: 'missing_subject' });
    if (!html && !text) return reply.code(400).send({ error: 'missing_content', message: 'Provide html, text, or a template_id' });

    // Verify sending domain + load the customer in parallel — two independent
    // single-row lookups that would otherwise be sequential round-trips on the
    // hot accept path.
    const fromDomain = body.from.split('@')[1]!.toLowerCase();
    const recipients = Array.isArray(body.to) ? body.to : [body.to];
    const [domain, customer] = await Promise.all([
      tenantScoped(req, (trx) =>
        trx
          .selectFrom('sending_domains')
          .select(['id', 'verified_at', 'dkim_verified'])
          .where('customer_id', '=', auth.customer_id)
          .where('domain', '=', fromDomain)
          .executeTakeFirst()
      ),
      db
        .selectFrom('customers')
        .select(['email', 'daily_quota', 'monthly_quota', 'status', 'billing_status', 'tier', 'kyc_level', 'new_account_until'])
        .where('id', '=', auth.customer_id)
        .executeTakeFirstOrThrow(),
    ]);
    if (!domain) return reply.code(403).send({ error: 'domain_not_registered', message: `Register ${fromDomain} via POST /v1/domains.` });
    if (!domain.verified_at || !domain.dkim_verified) {
      return reply.code(403).send({ error: 'domain_not_verified', message: `Verify ${fromDomain} first.` });
    }

    // Require email verification before real delivery. Checked after domain so
    // new users see the most actionable error first. Test-mode keys bypass this.
    if (!auth.test_mode && !auth.email_verified) {
      return reply.code(403).send({
        error: 'email_not_verified',
        message: 'Verify your account email before sending. Check your inbox or call POST /v1/resend-verification.',
      });
    }

    // Customer status / billing gate
    if (customer.status !== 'active') return reply.code(403).send({ error: 'account_suspended' });
    const billingAccess = await evaluateBillingAccess(auth.customer_id);
    if (!billingAccess.allowed) return reply.code(402).send({ error: 'billing_inactive', reason: billingAccess.reason, grace_ends_at: billingAccess.graceEndsAt });

    // KYC tiering: free/email-only accounts get a hard new-account daily cap until
    // they verify a payment method or business. Prevents abuse via throwaway signups.
    const NEW_ACCOUNT_CAP = Number(process.env.NEW_ACCOUNT_DAILY_CAP ?? 500);
    const isNewAccount = customer.new_account_until && new Date(customer.new_account_until) > new Date();
    const effectiveDaily =
      customer.kyc_level === 'email' || customer.kyc_level === 'domain'
        ? Math.min(customer.daily_quota, NEW_ACCOUNT_CAP)
        : customer.daily_quota;
    if (isNewAccount && (customer.kyc_level === 'email' || customer.kyc_level === 'domain') && recipients.length > NEW_ACCOUNT_CAP) {
      return reply.code(403).send({
        error: 'kyc_required',
        message: `New accounts are capped at ${NEW_ACCOUNT_CAP} recipients/request until a payment method or business is verified.`,
      });
    }

    // Per-customer fair-share back-pressure: reject when this customer already
    // has too many unprocessed jobs in the queue. Prevents one large customer
    // from filling the BullMQ send queue and starving smaller senders.
    const MAX_CUSTOMER_QUEUE_DEPTH = Number(process.env.MAX_CUSTOMER_QUEUE_DEPTH ?? 10_000);
    const currentDepth = await getCustomerQueueDepth(auth.customer_id);
    if (currentDepth + recipients.length > MAX_CUSTOMER_QUEUE_DEPTH) {
      reply.header('Retry-After', '60');
      return reply.code(429).send({
        error: 'queue_backpressure',
        message: `You have too many messages queued (${currentDepth} pending). Retry after your current batch processes.`,
        queue_depth: currentDepth,
        limit: MAX_CUSTOMER_QUEUE_DEPTH,
      });
    }

    // Atomic daily + monthly quota reservation (replaces the growing count scan).
    const quota = await tenantScoped(req, (trx) =>
      reserveQuota(auth.customer_id, recipients.length, effectiveDaily, customer.monthly_quota, trx)
    );
    if (!quota.allowed) {
      reply.header('Retry-After', '3600');
      return reply.code(429).send({
        error: 'quota_exceeded',
        message: `${quota.exceeded === 'monthly' ? 'Monthly' : 'Daily'} quota exceeded.`,
        daily: { used: quota.daily_used, limit: quota.daily_limit },
        monthly: { used: quota.monthly_used, limit: quota.monthly_limit },
      });
    }
    // Helper to give quota back if we bail out before actually enqueueing.
    const refundQuota = async () => releaseQuota(auth.customer_id, recipients.length);

    // Abuse: regex pre-filter + Bayesian classifier + URL reputation.
    const scan = scanContent(subject, html, text);
    const ml = await classify(subject, html, text);
    const combinedScore = Math.min(100, scan.score + Math.round(ml.combined_score * 0.5));
    const combinedReasons = [...scan.reasons];
    if (ml.spam_probability > 0.8) combinedReasons.push(`bayes_spam_${ml.spam_probability}`);
    if (ml.flagged_domains.length) combinedReasons.push(`bad_link_domains:${ml.flagged_domains.join(',')}`);

    const action = combinedScore >= 60 ? 'block' : combinedScore >= 30 ? 'review' : scan.action;
    if (action === 'block') {
      await refundQuota();
      messagesBlocked.inc({ reason: 'content_scan' });
      await db.insertInto('audit_log').values({
        customer_id: auth.customer_id,
        api_key_id: auth.api_key_id,
        action: 'send_blocked',
        resource: 'content_scan',
        ip: req.ip,
        metadata: { score: combinedScore, reasons: combinedReasons, bayes: ml.spam_probability },
      }).execute();
      return reply.code(422).send({ error: 'content_rejected', message: 'Message flagged by content policy.', reasons: combinedReasons });
    }

    // Abuse: volume anomaly
    const vol = await checkVolumeAnomaly(auth.customer_id, recipients.length);
    let ipPool = vol.anomalous ? 'quarantine' : (body.ip_pool ?? 'transactional');

    // Reputation guard: if the chosen pool is paused (bounce/complaint rate too
    // high), reject; if throttled, divert new senders to quarantine.
    const repAction = await poolAction(ipPool);
    if (repAction === 'pause') {
      await refundQuota();
      reply.header('Retry-After', '900');
      return reply.code(503).send({
        error: 'pool_paused',
        message: `IP pool '${ipPool}' is paused by the reputation guard (bounce/complaint rate too high).`,
      });
    }
    if (repAction === 'throttle' && ipPool === 'marketing') {
      ipPool = 'quarantine';
    }

    // Warmup capacity check on the selected pool
    const poolCheck = await canSendOnPool(ipPool, recipients.length);
    if (!poolCheck.allowed) {
      await refundQuota();
      reply.header('Retry-After', '3600');
      return reply.code(429).send({
        error: 'pool_capacity_exceeded',
        message: `IP pool '${ipPool}' is at warmup capacity (${poolCheck.used}/${poolCheck.cap} today).`,
        remaining: poolCheck.remaining,
      });
    }

    // Suppression filtering (+ spam-trap protection)
    const suppressed: string[] = [];
    const toInsert: Array<{ message_id: string; to: string }> = [];
    // Batched recipient screening: one Redis MGET + one DB query for
    // suppressions, and one DB query for trap/disposable intel across all
    // distinct domains — instead of two sequential round-trips per recipient.
    // For a 1000-recipient send this turns ~2000 awaits into ~3.
    const suppressedSet = await tenantScoped(req, (trx) => isSuppressedBatch(auth.customer_id, recipients, trx));
    const intelMap = await isTrapOrDisposableBatch(recipients);
    for (const rcpt of recipients) {
      const lower = rcpt.toLowerCase();
      if (suppressedSet.has(lower)) {
        suppressed.push(rcpt);
        continue;
      }
      if (intelMap.get(lower)?.trap) {
        suppressed.push(rcpt);
        continue;
      }
      toInsert.push({ message_id: generateMessageId(fromDomain), to: rcpt });
    }

    // Give back quota for recipients we won't actually send to.
    const notSending = recipients.length - toInsert.length;
    if (notSending > 0) await releaseQuota(auth.customer_id, notSending);

    if (toInsert.length === 0) {
      return reply.code(200).send({ accepted: 0, rejected: 0, message_ids: [], suppressed } as SendResponse);
    }

    // Validate unsubscribe group if provided — must belong to this customer.
    if (body.unsubscribe_group_id) {
      const grp = await db
        .selectFrom('unsubscribe_groups')
        .select('id')
        .where('id', '=', body.unsubscribe_group_id)
        .where('customer_id', '=', auth.customer_id)
        .executeTakeFirst();
      if (!grp) {
        await refundQuota();
        return reply.code(404).send({ error: 'not_found', message: 'Unsubscribe group not found.' });
      }

      // ENFORCE group-scoped opt-outs: recipients who unsubscribed from this
      // group must not receive future sends to it (this is what the one-click
      // unsubscribe promises the recipient). Group opt-outs are stored in
      // unsubscribe_group_members; global suppressions were already filtered.
      if (toInsert.length > 0) {
        const groupOptOuts = await db
          .selectFrom('unsubscribe_group_members')
          .select('email')
          .where('group_id', '=', body.unsubscribe_group_id)
          .where('customer_id', '=', auth.customer_id)
          .where('email', 'in', toInsert.map((r) => r.to.toLowerCase()))
          .execute();
        if (groupOptOuts.length > 0) {
          const optedOut = new Set(groupOptOuts.map((r) => r.email.toLowerCase()));
          const kept: typeof toInsert = [];
          for (const r of toInsert) {
            if (optedOut.has(r.to.toLowerCase())) suppressed.push(r.to);
            else kept.push(r);
          }
          const removed = toInsert.length - kept.length;
          toInsert.length = 0;
          toInsert.push(...kept);
          if (removed > 0) await releaseQuota(auth.customer_id, removed);
          if (toInsert.length === 0) {
            return reply
              .code(200)
              .send({ accepted: 0, rejected: 0, message_ids: [], suppressed } as SendResponse);
          }
        }
      }
    }

    const needsReview = action === 'review';
    const sendAt = body.send_at ? new Date(body.send_at) : null;
    const scheduled = sendAt && sendAt.getTime() > Date.now() + 1000;

    const laneDecision = await resolveSendLane(auth.customer_id, auth.tier, body.priority, toInsert.length);
    const priority = laneDecision.priority;

    // Attachments: validate (size caps + executable denylist) before anything
    // is stored. Content travels with the body object on fs/s3 stores; on the
    // inline store it rides in the row's attachments column.
    let storedAttachments: Array<{ filename: string; content_type: string; size: number; content_b64: string }> = [];
    if (body.attachments?.length) {
      const validated = validateAttachments(body.attachments);
      if (!validated.ok) {
        // Suppressed/trap recipients were already refunded above; only the
        // still-reserved remainder (toInsert) goes back.
        await releaseQuota(auth.customer_id, toInsert.length);
        return reply.code(422).send({ error: validated.error, message: validated.message });
      }
      storedAttachments = validated.attachments;
      const malwareScan = await scanAttachmentsForMalware(storedAttachments);
      if (!malwareScan.ok) {
        await releaseQuota(auth.customer_id, toInsert.length);
        if (malwareScan.error === 'attachment_malware_detected') {
          messagesBlocked.inc({ reason: 'attachment_malware' });
          return reply.code(422).send({
            error: malwareScan.error,
            message: `Attachment '${malwareScan.filename}' was rejected by malware scanning.`,
          });
        }
        reply.header('Retry-After', '30');
        return reply.code(503).send({ error: malwareScan.error, message: 'Attachment scanning is temporarily unavailable.' });
      }
    }

    // Offload the body once (content-addressed) when a non-inline store is
    // configured. The body is identical across recipients, so one object is
    // shared by all rows. Done before the transaction -- never hold a DB txn
    // open across object-store I/O.
    const bodyStore = getBodyStore();
    let bodyPtr: { storage: 'inline' | 'fs' | 's3'; object_key: string | null; size: number | null; hash: string | null } = {
      storage: 'inline', object_key: null, size: null, hash: null,
    };
    if (bodyStore.kind !== 'inline' && (html || text || storedAttachments.length > 0)) {
      const stored = await bodyStore.put({
        html: html ?? undefined,
        text: text ?? undefined,
        attachments: storedAttachments.length ? storedAttachments : undefined,
      });
      bodyPtr = { storage: stored.storage, object_key: stored.object_key ?? null, size: stored.size, hash: stored.hash };
    }
    const inlineHtml = bodyPtr.storage === 'inline' ? (html ?? null) : null;
    const inlineText = bodyPtr.storage === 'inline' ? (text ?? null) : null;
    // Row column: metadata always; content only when the body wasn't offloaded.
    const attachmentsColumn =
      storedAttachments.length === 0
        ? null
        : bodyPtr.storage === 'inline'
          ? storedAttachments
          : storedAttachments.map(({ filename, content_type, size }) => ({ filename, content_type, size }));

    const inserted = await tenantScoped(req, async (trx) => {
      const rows = await trx
        .insertInto('messages')
        .values(
          toInsert.map((m) => ({
            message_id: m.message_id,
            customer_id: auth.customer_id,
            from_address: body.from,
            from_name: body.from_name ?? null,
            to_address: m.to,
            reply_to: body.reply_to ?? null,
            subject: subject!,
            html_body: inlineHtml,
            text_body: inlineText,
            body_storage: bodyPtr.storage,
            body_object_key: bodyPtr.object_key,
            body_size: bodyPtr.size,
            body_hash: bodyPtr.hash,
            // node-pg serializes top-level JS arrays as PG array literals, not
            // JSON — stringify explicitly for the jsonb column.
            attachments: attachmentsColumn ? (JSON.stringify(attachmentsColumn) as any) : null,
            headers: body.headers ?? {},
            tags: body.tags ?? [],
            metadata: { ...(body.metadata ?? {}), ...(auth.test_mode ? { _test_mode: true } : {}) },
            tracking_opens: body.tracking?.opens ?? true,
            tracking_clicks: body.tracking?.clicks ?? true,
            ip_pool: ipPool,
            message_class: messageClass,
            template_id: templateId,
            risk_score: combinedScore,
            send_at: sendAt,
            unsubscribe_group_id: body.unsubscribe_group_id ?? null,
            status: needsReview ? ('held' as const) : ('queued' as const),
          }))
        )
        .returning(['message_id'])
        .execute();

      // CANSPAM-01 audit trail: an accepted non-commercial declaration is a
      // legal-classification decision — record who made it and for which
      // messages.
      if (messageClass !== 'commercial') {
        await trx.insertInto('audit_log').values({
          customer_id: auth.customer_id,
          api_key_id: auth.api_key_id,
          action: 'message_class_declared',
          resource: messageClass,
          ip: req.ip,
          metadata: { message_ids: rows.map((r) => r.message_id), message_class: messageClass },
        }).execute();
      }

      if (needsReview) {
        await trx.insertInto('review_queue').values(
          rows.map((m) => ({
            message_id: m.message_id,
            customer_id: auth.customer_id,
            risk_score: combinedScore,
            reasons: combinedReasons,
          }))
        ).execute();
        return rows;
      }

      await trx.insertInto('events').values(
        rows.map((m) => ({
          message_id: m.message_id,
          customer_id: auth.customer_id,
          event_type: 'queued' as const,
          payload: scheduled ? { send_at: sendAt!.toISOString() } : {},
        }))
      ).execute();

      // Capture the current trace context so the worker can continue the
      // distributed trace from this API request across the queue boundary.
      const traceCarrier = injectTraceContext();

      await createSendOutboxRows(
        rows.map((m) => ({
          message_id: m.message_id,
          customer_id: auth.customer_id,
          priority,
          run_at: scheduled ? sendAt : new Date(),
          trace_carrier: Object.keys(traceCarrier).length ? traceCarrier : undefined,
        })),
        trx
      );

      return rows;
    });

    // review_queue rows were already inserted inside the transaction above.
    if (needsReview) {
      return reply.code(202).send({
        accepted: inserted.length,
        rejected: 0,
        message_ids: inserted.map((m) => m.message_id),
        suppressed,
        status: 'held_for_review',
      });
    }

    // Track per-customer queue depth for fair-share backpressure on future requests.
    incrementQueueDepth(auth.customer_id, inserted.length).catch(() => {});

    // Best-effort immediate dispatch. If Redis is unavailable after the DB
    // commit, the durable send_outbox row remains pending and the worker
    // scheduler will retry it.
    try {
      await drainSendOutbox({ messageIds: inserted.map((m) => m.message_id), limit: inserted.length });
    } catch (err) {
      req.log.warn({ err }, 'send outbox dispatch deferred');
    }

    messagesAccepted.inc({ customer_tier: auth.tier });

    // Fire-and-forget quota threshold check. Never blocks the send response.
    checkQuotaThresholds(
      auth.customer_id,
      quota.daily_used, quota.daily_limit,
      quota.monthly_used, quota.monthly_limit,
    ).then(async (crossed) => {
      for (const c of crossed) {
        await sendQuotaWarningEmail({
          to: customer.email,
          scope: c.scope,
          threshold: c.threshold,
          used: c.scope === 'daily' ? quota.daily_used : quota.monthly_used,
          limit: c.scope === 'daily' ? quota.daily_limit : quota.monthly_limit,
        }).catch(() => {});
      }
    }).catch(() => {});

    return reply.code(202).send({
      accepted: inserted.length,
      rejected: 0,
      message_ids: inserted.map((m) => m.message_id),
      suppressed,
      ...(scheduled ? { scheduled_for: sendAt!.toISOString() } : {}),
      ...(body.priority
        ? {
            priority_applied: laneDecision.lane,
            ...(laneDecision.downgraded_reason ? { priority_downgraded_reason: laneDecision.downgraded_reason } : {}),
          }
        : {}),
    } as SendResponse);
  });

  // Batch send: up to 100 distinct messages per call.
  // Each entry can have its own recipient, subject, body, template, and
  // send_at. Domain + quota checks are shared; content scanning and
  // suppression are per-message. All accepted messages are committed in a
  // single transaction, then best-effort dispatched via send_outbox drain.
  const BatchSchema = z.object({
    messages: z
      // The critical lane and attachments are single-send only for now
      // (batches are bulk-shaped and share one request body budget); those
      // fields in a batch entry are stripped.
      .array(SendSchema.omit({ priority: true, attachments: true }).extend({ to: z.string().email() }))
      .min(1)
      .max(100),
  });

  app.post(
    '/send/batch',
    {
      config: {
        rateLimit: {
          max: Number(process.env.SEND_BATCH_RATE_LIMIT_PER_MINUTE ?? 60),
          timeWindow: '1 minute',
        },
      },
      preHandler: [requireScope('send')],
    },
    async (req, reply) => {
      const auth = req.auth!;

      try {
        const counts = await sendQueue.getJobCounts('waiting', 'delayed');
        if ((counts.waiting ?? 0) + (counts.delayed ?? 0) > BACKPRESSURE_THRESHOLD) {
          backpressureRejections.inc();
          reply.header('Retry-After', '30');
          return reply.code(503).send({ error: 'backpressure', message: 'The send queue is saturated. Retry shortly.' });
        }
      } catch { /* fail open */ }

      const parsed = BatchSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
      const { messages } = parsed.data;

      if (!auth.test_mode && !auth.email_verified) {
        return reply.code(403).send({ error: 'email_not_verified', message: 'Verify your account email before sending.' });
      }

      const customer = await db
        .selectFrom('customers')
        .select(['email', 'daily_quota', 'monthly_quota', 'status', 'billing_status', 'tier', 'kyc_level', 'new_account_until'])
        .where('id', '=', auth.customer_id)
        .executeTakeFirstOrThrow();
      if (customer.status !== 'active') return reply.code(403).send({ error: 'account_suspended' });
      const billingAccess = await evaluateBillingAccess(auth.customer_id);
      if (!billingAccess.allowed) return reply.code(402).send({ error: 'billing_inactive', reason: billingAccess.reason, grace_ends_at: billingAccess.graceEndsAt });

      const NEW_ACCOUNT_CAP = Number(process.env.NEW_ACCOUNT_DAILY_CAP ?? 500);
      const effectiveDaily =
        customer.kyc_level === 'email' || customer.kyc_level === 'domain'
          ? Math.min(customer.daily_quota, NEW_ACCOUNT_CAP)
          : customer.daily_quota;

      // Verify all distinct sending domains upfront — fail fast before quota.
      const fromDomains = [...new Set(messages.map((m) => m.from.split('@')[1]!.toLowerCase()))];
      const verifiedDomains = await tenantScoped(req, (trx) =>
        trx
          .selectFrom('sending_domains')
          .select(['domain'])
          .where('customer_id', '=', auth.customer_id)
          .where('domain', 'in', fromDomains)
          .where('verified_at', 'is not', null)
          .where('dkim_verified', '=', true)
          .execute()
      );
      const verifiedSet = new Set(verifiedDomains.map((d) => d.domain));
      const unverified = fromDomains.find((d) => !verifiedSet.has(d));
      if (unverified) return reply.code(403).send({ error: 'domain_not_verified', message: `Domain ${unverified} not registered or verified.` });

      // Batch quota reservation for all recipients.
      const totalRecipients = messages.length;
      const quota = await tenantScoped(req, (trx) =>
        reserveQuota(auth.customer_id, totalRecipients, effectiveDaily, customer.monthly_quota, trx)
      );
      if (!quota.allowed) {
        reply.header('Retry-After', '3600');
        return reply.code(429).send({
          error: 'quota_exceeded',
          message: `${quota.exceeded === 'monthly' ? 'Monthly' : 'Daily'} quota exceeded.`,
          daily: { used: quota.daily_used, limit: quota.daily_limit },
          monthly: { used: quota.monthly_used, limit: quota.monthly_limit },
        });
      }

      // Per-message processing: content scan, suppression, template resolution.
      const priority = auth.tier === 'enterprise' ? 1 : auth.tier === 'paid' ? 5 : 10;
      const results: Array<{
        index: number;
        message_id?: string;
        accepted: boolean;
        suppressed?: boolean;
        held_for_review?: boolean;
        error?: string;
        scheduled_for?: string;
      }> = [];

      const toCommit: Array<{
        msg: typeof messages[number];
        message_id: string;
        subject: string;
        html: string | null;
        text: string | null;
        templateId: string | null;
        ipPool: string;
        messageClass: 'transactional' | 'relationship' | 'commercial';
        needsReview: boolean;
        combinedScore: number;
        combinedReasons: string[];
        sendAt: Date | null;
        unsubscribeGroupId: string | null;
      }> = [];

      let refundCount = 0;

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!;
        let subject = msg.subject;
        let html = msg.html;
        let text = msg.text;
        let templateId: string | null = null;

        // CANSPAM-01: same classification authorization as single /send,
        // rejected per-entry so the rest of the batch proceeds.
        const messageClass = msg.message_class ?? 'commercial';
        if (messageClass !== 'commercial' && !auth.scopes.includes('classify') && !auth.scopes.includes('admin')) {
          results.push({ index: i, accepted: false, error: 'classification_not_authorized' });
          refundCount++;
          continue;
        }

        if (msg.template_id) {
          const tpl = await tenantScoped(req, (trx) =>
            trx
              .selectFrom('templates')
              .selectAll()
              .where('id', '=', msg.template_id!)
              .where('customer_id', '=', auth.customer_id)
              .executeTakeFirst()
          );
          if (!tpl) {
            results.push({ index: i, accepted: false, error: `template_not_found:${msg.template_id}` });
            refundCount++;
            continue;
          }
          let rendered;
          try {
            rendered = renderTemplate(tpl, msg.variables ?? {}, {
              onMissing: msg.require_all_variables ? 'error' : 'ignore',
            });
          } catch (err) {
            if (err instanceof MissingTemplateVariablesError) {
              results.push({ index: i, accepted: false, error: `missing_template_variables:${err.missing.join(',')}` });
              refundCount++;
              continue;
            }
            throw err;
          }
          subject = rendered.subject; html = rendered.html; text = rendered.text; templateId = tpl.id;
        }

        if (!subject) { results.push({ index: i, accepted: false, error: 'missing_subject' }); refundCount++; continue; }
        if (!html && !text) { results.push({ index: i, accepted: false, error: 'missing_content' }); refundCount++; continue; }

        if (await tenantScoped(req, (trx) => isSuppressed(auth.customer_id, msg.to, trx))) {
          results.push({ index: i, accepted: false, suppressed: true });
          refundCount++;
          continue;
        }
        const intel = await isTrapOrDisposable(msg.to);
        if (intel.trap) { results.push({ index: i, accepted: false, suppressed: true }); refundCount++; continue; }

        const scan = scanContent(subject, html, text);
        const ml = await classify(subject, html, text);
        const combinedScore = Math.min(100, scan.score + Math.round(ml.combined_score * 0.5));
        const combinedReasons = [...scan.reasons];
        if (ml.spam_probability > 0.8) combinedReasons.push(`bayes_spam_${ml.spam_probability}`);
        if (ml.flagged_domains.length) combinedReasons.push(`bad_link_domains:${ml.flagged_domains.join(',')}`);
        const action = combinedScore >= 60 ? 'block' : combinedScore >= 30 ? 'review' : scan.action;

        if (action === 'block') {
          results.push({ index: i, accepted: false, error: 'content_rejected' });
          messagesBlocked.inc({ reason: 'content_scan' });
          refundCount++;
          continue;
        }

        const vol = await checkVolumeAnomaly(auth.customer_id, 1);
        const ipPool = vol.anomalous ? 'quarantine' : (msg.ip_pool ?? 'transactional');
        const repAction = await poolAction(ipPool);
        if (repAction === 'pause') { results.push({ index: i, accepted: false, error: 'pool_paused' }); refundCount++; continue; }

        const fromDomain = msg.from.split('@')[1]!.toLowerCase();
        const message_id = generateMessageId(fromDomain);
        const sendAt = msg.send_at ? new Date(msg.send_at) : null;

        // Validate unsubscribe group ownership if provided.
        let unsubscribeGroupId: string | null = msg.unsubscribe_group_id ?? null;
        if (unsubscribeGroupId) {
          const grp = await db.selectFrom('unsubscribe_groups').select('id')
            .where('id', '=', unsubscribeGroupId).where('customer_id', '=', auth.customer_id).executeTakeFirst();
          if (!grp) { results.push({ index: i, accepted: false, error: 'unsubscribe_group_not_found' }); refundCount++; continue; }

          // ENFORCE group-scoped opt-outs (parity with single /send): a
          // recipient who unsubscribed from this group is skipped and refunded.
          const optedOut = await db
            .selectFrom('unsubscribe_group_members')
            .select('id')
            .where('group_id', '=', unsubscribeGroupId)
            .where('customer_id', '=', auth.customer_id)
            .where('email', '=', msg.to.toLowerCase())
            .executeTakeFirst();
          if (optedOut) { results.push({ index: i, accepted: false, suppressed: true }); refundCount++; continue; }
        }

        toCommit.push({ msg, message_id, subject, html: html ?? null, text: text ?? null, templateId, ipPool, messageClass, needsReview: action === 'review', combinedScore, combinedReasons, sendAt, unsubscribeGroupId });
        results.push({ index: i, message_id, accepted: true, held_for_review: action === 'review', ...(sendAt && sendAt.getTime() > Date.now() + 1000 ? { scheduled_for: sendAt.toISOString() } : {}) });
      }

      if (refundCount > 0) await releaseQuota(auth.customer_id, refundCount);

      if (toCommit.length > 0) {
        const bodyStore = getBodyStore();
        const traceCarrier = injectTraceContext();

        // Offload each message body BEFORE opening the transaction (never hold a
        // DB txn open across object-store I/O). Unlike single-send, each batch
        // entry can carry a distinct body, so we offload per-message. Bodies are
        // content-addressed, so identical bodies across the batch still dedupe to
        // one object. Previously this path hard-coded body_storage:'inline' and
        // null'd the body when a non-inline store was configured WITHOUT calling
        // put() — silently dropping the body and delivering empty emails.
        const bodyPtrByMessage = new Map<
          string,
          { storage: 'inline' | 'fs' | 's3'; object_key: string | null; size: number | null; hash: string | null; html: string | null; text: string | null }
        >();
        for (const c of toCommit) {
          if (bodyStore.kind !== 'inline' && (c.html || c.text)) {
            const stored = await bodyStore.put({ html: c.html ?? undefined, text: c.text ?? undefined });
            bodyPtrByMessage.set(c.message_id, {
              storage: stored.storage,
              object_key: stored.object_key ?? null,
              size: stored.size,
              hash: stored.hash,
              html: null,
              text: null,
            });
          } else {
            bodyPtrByMessage.set(c.message_id, {
              storage: 'inline',
              object_key: null,
              size: null,
              hash: null,
              html: c.html,
              text: c.text,
            });
          }
        }

        await tenantScoped(req, async (trx) => {
          const insertedMessages = await trx.insertInto('messages').values(
            toCommit.map((c) => {
              const ptr = bodyPtrByMessage.get(c.message_id)!;
              return ({
              message_id: c.message_id,
              customer_id: auth.customer_id,
              from_address: c.msg.from,
              from_name: c.msg.from_name ?? null,
              to_address: c.msg.to,
              reply_to: c.msg.reply_to ?? null,
              subject: c.subject,
              html_body: ptr.html,
              text_body: ptr.text,
              body_storage: ptr.storage,
              body_object_key: ptr.object_key, body_size: ptr.size, body_hash: ptr.hash,
              headers: c.msg.headers ?? {},
              tags: c.msg.tags ?? [],
              metadata: { ...(c.msg.metadata ?? {}), ...(auth.test_mode ? { _test_mode: true } : {}) },
              tracking_opens: c.msg.tracking?.opens ?? true,
              tracking_clicks: c.msg.tracking?.clicks ?? true,
              ip_pool: c.ipPool,
              message_class: c.messageClass,
              template_id: c.templateId,
              risk_score: c.combinedScore,
              send_at: c.sendAt,
              unsubscribe_group_id: c.unsubscribeGroupId,
              status: c.needsReview ? ('held' as const) : ('queued' as const),
              });
            })
          ).returning(['message_id']).execute();

          // CANSPAM-01 audit trail (parity with single /send).
          const declared = toCommit.filter((c) => c.messageClass !== 'commercial');
          if (declared.length) {
            await trx.insertInto('audit_log').values({
              customer_id: auth.customer_id,
              api_key_id: auth.api_key_id,
              action: 'message_class_declared',
              resource: 'batch',
              ip: req.ip,
              metadata: {
                message_ids: declared.map((c) => c.message_id),
                classes: Object.fromEntries(declared.map((c) => [c.message_id, c.messageClass])),
              },
            }).execute();
          }

          const reviewItems = toCommit.filter((c) => c.needsReview);
          const sendItems = toCommit.filter((c) => !c.needsReview);

          if (reviewItems.length) {
            await trx.insertInto('review_queue').values(
              reviewItems.map((c) => ({ message_id: c.message_id, customer_id: auth.customer_id, risk_score: c.combinedScore, reasons: c.combinedReasons }))
            ).execute();
          }

          if (sendItems.length) {
            await trx.insertInto('events').values(
              sendItems.map((c) => ({ message_id: c.message_id, customer_id: auth.customer_id, event_type: 'queued' as const, payload: c.sendAt ? { send_at: c.sendAt.toISOString() } : {} }))
            ).execute();

            await createSendOutboxRows(
              sendItems.map((c) => ({
                message_id: c.message_id, customer_id: auth.customer_id, priority,
                run_at: (c.sendAt && c.sendAt.getTime() > Date.now() + 1000) ? c.sendAt : new Date(),
                trace_carrier: Object.keys(traceCarrier).length ? traceCarrier : undefined,
              })),
              trx
            );
          }

          return insertedMessages;
        });

        const sendableIds = toCommit.filter((c) => !c.needsReview).map((c) => c.message_id);
        if (sendableIds.length) {
          try {
            await drainSendOutbox({ messageIds: sendableIds, limit: sendableIds.length });
          } catch (err) {
            req.log.warn({ err }, 'batch send outbox dispatch deferred');
          }
        }
        messagesAccepted.inc({ customer_tier: auth.tier });
      }

      const accepted = results.filter((r) => r.accepted).length;
      const rejected = results.filter((r) => !r.accepted && !r.suppressed).length;
      const suppressed = results.filter((r) => r.suppressed).length;

      return reply.code(202).send({ accepted, rejected, suppressed, results });
    }
  );

  // Persist the final response for any request that reserved an idempotency key.
  app.addHook('onSend', async (req, reply, payload) => {
    const key = (req as any).idempotencyKey as string | undefined;
    if (!key || req.url.split('?')[0] !== '/v1/send') return payload;
    const auth = req.auth;
    if (!auth) return payload;
    try {
      const bodyObj =
        typeof payload === 'string' ? JSON.parse(payload) : (payload as Record<string, unknown>);
      await recordIdempotentResponse(auth.customer_id, key, reply.statusCode, bodyObj ?? {});
    } catch (err) {
      req.log.warn({ err }, 'failed to record idempotent response');
    }
    return payload;
  });
};
