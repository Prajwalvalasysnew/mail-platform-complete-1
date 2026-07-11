import { Worker } from 'bullmq';
import type { Logger } from 'pino';
import * as cheerio from 'cheerio';
import {
  db,
  redisOptions,
  encodeMessageIdForUrl,
  buildVerpToken,
  getTransport,
  getSandboxTransport,
  recordPoolSends,
  messagesSent,
  messagesBlocked,
  sendDuration,
  deadLetter,
  deadLetterTotal,
  QUEUE_PREFIX,
  withRemoteContext,
  decrementQueueDepth,
  addSuppression,
  type SendJobData,
  loadMessageBody,
  isMessagePrivacyErased,
} from '@platform/shared';

const TRACKING_DOMAIN = process.env.TRACKING_DOMAIN ?? 'http://localhost:4000';
const BOUNCE_DOMAIN = process.env.BOUNCE_DOMAIN ?? 'bounces.localhost';
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 50);

const transport = getTransport();
const sandbox = getSandboxTransport();

// Single-pass HTML transform: rewrite trackable links and inject the open pixel
// using a real HTML parser (cheerio) instead of regex, and batch-insert all
// tracked_links in one statement instead of one round-trip per link.
async function transformHtml(
  html: string,
  messageId: string,
  opts: { rewriteClicks: boolean; injectPixel: boolean }
): Promise<string> {
  const encoded = encodeMessageIdForUrl(messageId);
  const $ = cheerio.load(html, null, true);

  if (opts.rewriteClicks) {
    // Collect unique, eligible URLs first.
    const urls: string[] = [];
    const seen = new Set<string>();
    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      if (!/^https?:\/\//i.test(href)) return; // skip mailto:, tel:, anchors
      if (href.startsWith(TRACKING_DOMAIN)) return;
      if (!seen.has(href)) {
        seen.add(href);
        urls.push(href);
      }
    });

    if (urls.length > 0) {
      // Batch insert all links in a single statement, return id+url mapping.
      const rows = await db
        .insertInto('tracked_links')
        .values(urls.map((u) => ({ message_id: messageId, original_url: u })))
        .returning(['id', 'original_url'])
        .execute();
      const idByUrl = new Map(rows.map((r) => [r.original_url, r.id]));

      $('a[href]').each((_i, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const id = idByUrl.get(href);
        if (!id) return;
        $(el).attr('href', `${TRACKING_DOMAIN}/c/${encoded}/${id}`);
      });
    }
  }

  if (opts.injectPixel) {
    const pixel = `<img src="${TRACKING_DOMAIN}/o/${encoded}" width="1" height="1" border="0" style="display:block;width:1px;height:1px;" alt="" />`;
    if ($('body').length) $('body').append(pixel);
    else $.root().append(pixel);
  }

  return $.html();
}

function buildReturnPath(messageId: string): string {
  // Signed, tamper-resistant VERP token (see buildVerpToken in shared/crypto).
  const fullToken = buildVerpToken(messageId);
  if (fullToken.length <= 64) return `${fullToken}@${BOUNCE_DOMAIN}`;

  // SMTP local-parts are limited to 64 octets. Long customer domains can make
  // the full Message-ID token too large, so fall back to the generated hex id.
  const shortId = messageId.replace(/[<>]/g, '').split('@')[0]!;
  return `${buildVerpToken(shortId)}@${BOUNCE_DOMAIN}`;
}

async function bumpUsage(customerId: string, field: 'sent' | 'delivered' | 'bounced' | 'complained') {
  const today = new Date().toISOString().slice(0, 10);
  await db
    .insertInto('usage_daily')
    .values({ customer_id: customerId, usage_date: today, [field]: 1 } as any)
    .onConflict((oc) =>
      oc.columns(['customer_id', 'usage_date']).doUpdateSet((eb) => ({
        [field]: eb(`usage_daily.${field}` as any, '+', 1),
      }) as any)
    )
    .execute();
}

export function startSendWorker(logger: Logger) {
  const worker = new Worker<SendJobData>(
    `${QUEUE_PREFIX}send`,
    async (job) => {
      // Continue the distributed trace started by the API request that queued
      // this job.  No-op when tracing is not configured.
      return withRemoteContext((job.data as any)._trace, async () => {
      const timer = sendDuration.startTimer();
      const log = logger.child({ message_id: job.data.message_id });

      if (await isMessagePrivacyErased(job.data.message_id, job.data.customer_id)) {
        log.info('privacy tombstone present - dropping stale send job');
        decrementQueueDepth(job.data.customer_id).catch(() => {});
        timer();
        return { skipped: true, erased: true };
      }

      // ATOMIC CLAIM: flip queued -> sending in a single UPDATE ... RETURNING.
      // With the old select/check/update pattern, two workers processing a
      // duplicate job (DLQ replay, admin re-enqueue, stale-recovery re-add)
      // could both read status='queued' and both deliver the message. The
      // conditional UPDATE makes exactly one claimant win; everyone else sees
      // zero rows and skips.
      const msg = await db.updateTable('messages')
        .set((eb) => ({ status: 'sending', attempts: eb('attempts', '+', 1), sending_at: new Date() }))
        .where('message_id', '=', job.data.message_id)
        .where('status', '=', 'queued')
        .returningAll()
        .executeTakeFirst();
      if (!msg) {
        const existing = await db
          .selectFrom('messages')
          .select(['status'])
          .where('message_id', '=', job.data.message_id)
          .executeTakeFirst();
        if (!existing) log.warn('message not found - dropping');
        else log.warn({ status: existing.status }, 'not in queued state (already claimed?) - skipping');
        timer();
        return { skipped: true };
      }

      // Test-mode messages (mp_test_ keys) go to the sandbox transport: full
      // pipeline, no real delivery, no reputation impact.
      const isTest = (msg.metadata as any)?._test_mode === true;
      const tx = isTest ? sandbox : transport;

      try {
        // Message preparation (tracking rewrite, return-path) runs INSIDE the
        // try so a preparation error is handled like any other send failure
        // (status reset for retry) instead of throwing while the row is left
        // pinned at 'sending', which strands it permanently.
        const loaded = await loadMessageBody(msg);
        let html = loaded.html;
        if (html && (msg.tracking_clicks || msg.tracking_opens)) {
          html = await transformHtml(html, msg.message_id, {
            rewriteClicks: msg.tracking_clicks,
            injectPixel: msg.tracking_opens,
          });
        }

        const encoded = encodeMessageIdForUrl(msg.message_id);
        // Group-scoped unsubscribes land in unsubscribe_group_members; global
        // unsubs (no group) add a full suppression. The tracker disambiguates.
        const groupSuffix = (msg as any).unsubscribe_group_id ? `?group=${encodeURIComponent((msg as any).unsubscribe_group_id)}` : '';
        const unsubUrl = `${TRACKING_DOMAIN}/u/${encoded}${groupSuffix}`;
        const envelopeFrom = buildReturnPath(msg.message_id);

        // CAN-SPAM §5(a)(5): physical postal address must appear in the body.
        // Fetch once per message from the customer record.
        const customer = await db
          .selectFrom('customers')
          .select('physical_address')
          .where('id', '=', msg.customer_id)
          .executeTakeFirst();
        const physicalAddress = customer?.physical_address ?? null;

        // Enforce for live sends. Test-mode sends skip enforcement (no real
        // delivery, no legal exposure). Set SKIP_PHYSICAL_ADDRESS_CHECK=true
        // only during a phased rollout — remove after all customers are updated.
        if (!physicalAddress && !isTest && process.env.SKIP_PHYSICAL_ADDRESS_CHECK !== 'true') {
          const paErr: any = new Error(
            'physical_address_required: CAN-SPAM §5(a)(5) requires a physical postal address in every commercial email. ' +
            'Set it via PATCH /v1/profile or the admin panel, then retry.'
          );
          paErr.permanent = true;
          throw paErr;
        }

        let finalHtml = html;
        let finalText = loaded.text;
        if (physicalAddress) {
          if (finalHtml) {
            finalHtml += `\n<div style="font-size:11px;color:#888;margin-top:24px;border-top:1px solid #eee;padding-top:8px;">${physicalAddress.replace(/\n/g, '<br>')} &nbsp;&bull;&nbsp; <a href="${unsubUrl}">Unsubscribe</a></div>`;
          }
          if (finalText) {
            finalText += `\n\n--\n${physicalAddress}\nUnsubscribe: ${unsubUrl}`;
          }
        }

        const result = await tx.send({
          envelopeFrom,
          from: msg.from_name ? `"${msg.from_name}" <${msg.from_address}>` : msg.from_address,
          to: msg.to_address,
          replyTo: msg.reply_to ?? undefined,
          subject: msg.subject,
          html: finalHtml,
          text: finalText,
          messageId: msg.message_id,
          headers: {
            ...msg.headers,
            // Internal headers used by Haraka transport only (SES ignores them)
            'X-MP-Customer-ID': msg.customer_id,
            'X-MP-Message-ID': msg.message_id,
            'X-MP-IP-Pool': msg.ip_pool,
            'List-Unsubscribe': `<${unsubUrl}>, <mailto:unsubscribe@${BOUNCE_DOMAIN}?subject=${msg.message_id}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });

        // Record the audit event and usage FIRST, then flip status to
        // 'accepted' last. Consumers (tests, dashboards, downstream logic) treat
        // 'accepted' as the completion signal, so everything that should be
        // observable by then must already be committed. Ordering it this way
        // closes the race where a reader sees 'accepted' before usage is bumped.
        await db.insertInto('events')
          .values({
            message_id: msg.message_id,
            customer_id: msg.customer_id,
            event_type: 'sent',
            payload: { response: result.response, provider_id: result.provider_message_id, transport: tx.name },
          })
          .execute();

        await recordPoolSends(msg.ip_pool, 1);
        await bumpUsage(msg.customer_id, 'sent');

        await db.updateTable('messages')
          .set({
            status: 'accepted',
            accepted_at: new Date(),
            smtp_response: result.response,
            provider_message_id: result.provider_message_id,
          })
          .where('message_id', '=', msg.message_id)
          .execute();

        messagesSent.inc({ transport: tx.name, ip_pool: msg.ip_pool });
        decrementQueueDepth(msg.customer_id).catch(() => {});

        log.info({ transport: tx.name, response: result.response }, 'accepted by transport');
        timer();
        return { accepted: true };
      } catch (err: any) {
        timer();
        log.error({ err: err.message, permanent: err.permanent, code: err.code }, 'send failed');

        if (err.permanent) {
          await db.updateTable('messages')
            .set({ status: 'failed', failure_reason: err.message, smtp_response: err.response ?? null })
            .where('message_id', '=', msg.message_id)
            .execute();
          await db.insertInto('events')
            .values({
              message_id: msg.message_id,
              customer_id: msg.customer_id,
              event_type: 'failed',
              // Record the failure category (gap analysis #14) for observability
              // and downstream analytics/retry-shaping.
              payload: { error: err.message, code: err.code, category: err.category, strategy: err.strategy },
            })
            .execute();
          // Auto-suppress on a hard-bounce-class failure (invalid recipient),
          // so we stop mailing an address the ISP says doesn't exist. Driven by
          // the taxonomy's `suppress` signal, not a broad "any 5xx" rule.
          if (err.suppress) {
            await addSuppression(
              msg.customer_id,
              msg.to_address,
              'hard_bounce',
              `SMTP ${err.code ?? ''}: ${err.category ?? 'invalid_recipient'}`.trim(),
            ).catch(() => {});
          }
          messagesBlocked.inc({ reason: err.category ? `smtp_${err.category}` : 'permanent_smtp_failure' });
          decrementQueueDepth(msg.customer_id).catch(() => {});
          return { failed: true };
        }
        // transient — requeue for BullMQ retry
        await db.updateTable('messages')
          .set({ status: 'queued', failure_reason: err.message })
          .where('message_id', '=', msg.message_id)
          .execute();
        throw err;
      }
      }); // end withRemoteContext
    },
    { connection: redisOptions, concurrency: CONCURRENCY }
  );

  worker.on('failed', async (job, err) => {
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts?.attempts ?? 1;
    if (job && attemptsMade >= maxAttempts) {
      logger.error({ job_id: job.id, err: err.message, attemptsMade }, 'send job exhausted retries — dead-lettering');
      // Move the message to a terminal 'failed' state. Without this it would
      // linger at 'queued' after the last retry with nothing left to re-drive
      // it. Guarded so we never clobber a message that meanwhile reached a
      // terminal/accepted state.
      const messageId = job.data?.message_id;
      if (messageId) {
        try {
          await db.updateTable('messages')
            .set({ status: 'failed', failure_reason: `exhausted retries: ${err.message}` })
            .where('message_id', '=', messageId)
            .where('status', 'in', ['queued', 'sending'])
            .execute();
          await db.insertInto('events')
            .values({ message_id: messageId, customer_id: job.data.customer_id, event_type: 'failed', payload: { error: err.message, reason: 'exhausted_retries' } })
            .execute();
        } catch (statusErr: any) {
          logger.error({ err: statusErr?.message, message_id: messageId }, 'failed to mark message failed after exhaustion');
        }
      }
      // Decrement fair-share depth counter on final failure.
      const customerId = job.data?.customer_id;
      if (customerId) decrementQueueDepth(customerId).catch(() => {});
      try {
        await deadLetter('send', job, err.message);
        deadLetterTotal.inc({ source_queue: 'send' });
      } catch (dlErr: any) {
        logger.error({ err: dlErr?.message }, 'failed to dead-letter job');
      }
    } else {
      logger.warn({ job_id: job?.id, err: err.message, attemptsMade }, 'send job failed (will retry)');
    }
  });

  return worker;
}
