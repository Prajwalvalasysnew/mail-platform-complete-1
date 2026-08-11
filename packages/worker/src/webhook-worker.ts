import { Worker } from 'bullmq';
import { request, Agent } from 'undici';
import { isIP } from 'node:net';
import type { Logger } from 'pino';
import {
  db,
  redisOptions,
  signWebhook,
  resolveAndAssertPublicUrl,
  SsrfError,
  webhookDeliveries,
  webhookDeliveryDuration,
  deadLetter,
  deadLetterTotal,
  QUEUE_PREFIX,
  webhookBackoffStrategy,
  type WebhookJobData,
  isMessagePrivacyErased,
} from '@platform/shared';

const TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS ?? 10_000);

// A 4xx (other than 408/429) is a client error that won't fix itself on retry —
// the endpoint is gone, unauthorized, or rejecting our payload. Burning the
// retry budget on it just hammers a broken endpoint. 408/429 and all 5xx are
// transient and worth retrying.
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

/**
 * Build an undici dispatcher that pins outbound connections to one of the
 * pre-validated IP addresses, closing the DNS-rebinding TOCTOU window between
 * the SSRF check and the actual connect. The custom `lookup` short-circuits DNS
 * and hands undici the vetted address; the request still carries the original
 * hostname for Host header + TLS SNI. Falls back to undefined (default agent) if
 * no addresses were captured (e.g. ALLOW_PRIVATE dev mode).
 */
export function ipPinnedDispatcher(addresses: string[]): Agent | undefined {
  if (!addresses || addresses.length === 0) return undefined;
  const pinned = addresses[0];
  if (!pinned) return undefined;
  const family = isIP(pinned); // 4 or 6
  return new Agent({
    connect: {
      // Mimic node's dns.lookup contract. undici may call with options.all=true
      // (expecting an array of {address,family}) or the single-result form
      // (cb(err, address, family)). Handle both so the socket always targets the
      // vetted IP.
      lookup: (
        _hostname: string,
        options: { all?: boolean } | undefined,
        cb: (err: Error | null, address: any, family?: number) => void
      ) => {
        const fam = family || 4;
        if (options && options.all) {
          cb(null, [{ address: pinned, family: fam }] as any);
        } else {
          cb(null, pinned, fam);
        }
      },
    },
  });
}

async function logDelivery(
  webhookId: string,
  eventId: number | string | null,
  eventType: string,
  attempt: number,
  outcome: 'success' | 'failure' | 'dropped' | 'blocked',
  durationMs: number,
  statusCode: number | null,
  error: string | null,
): Promise<void> {
  await db.insertInto('webhook_delivery_log').values({
    webhook_id: webhookId,
    event_id: typeof eventId === 'number' ? eventId : null,
    event_type: eventType,
    attempt,
    status_code: statusCode,
    outcome,
    duration_ms: durationMs,
    error,
  } as any).execute();
}

export function startWebhookWorker(logger: Logger) {
  const worker = new Worker<WebhookJobData>(
    `${QUEUE_PREFIX}webhooks`,
    async (job) => {
      const { webhook_id, payload, event_type, event_id } = job.data;
      const log = logger.child({ webhook_id, event_type });
      const attempt = (job.attemptsMade ?? 0) + 1;
      const startMs = Date.now();

      const messageId = typeof payload?.message_id === 'string' ? payload.message_id : null;
      if (messageId && await isMessagePrivacyErased(messageId)) {
        log.info({ message_id: messageId }, 'privacy tombstone present - dropping stale webhook job');
        return;
      }

      const wh = await db
        .selectFrom('webhooks')
        .select(['url', 'secret', 'enabled'])
        .where('id', '=', webhook_id)
        .executeTakeFirst();

      if (!wh || !wh.enabled) {
        log.info('webhook disabled or deleted, skipping');
        return;
      }

      // SSRF guard: re-validate the destination at delivery time (DNS can change
      // after registration). A private/reserved/loopback target is a permanent
      // condition — do NOT retry, and do NOT surface internal responses.
      let validatedAddresses: string[] = [];
      try {
        const checked = await resolveAndAssertPublicUrl(wh.url);
        validatedAddresses = checked.addresses;
      } catch (err) {
        if (err instanceof SsrfError) {
          log.error({ url: wh.url, reason: err.message }, 'webhook target blocked by SSRF guard — dropping');
          webhookDeliveries.inc({ outcome: 'blocked' });
          await logDelivery(webhook_id, event_id ?? null, event_type, attempt, 'blocked', Date.now() - startMs, null, err.message).catch(() => {});
          return; // swallow: not retryable
        }
        throw err;
      }

      const body = JSON.stringify(payload);
      const ts = Math.floor(Date.now() / 1000);
      const signature = signWebhook(wh.secret, body, ts);

      // Pin the connection to the IP we just validated. Without this, undici
      // re-resolves the hostname when it connects — a malicious DNS server could
      // return a public IP for the validation lookup and a private IP
      // (e.g. 169.254.169.254) for the actual request (DNS-rebinding TOCTOU).
      // The custom lookup forces the socket to the vetted address while the
      // original hostname is still used for the Host header and TLS SNI.
      const dispatcher = ipPinnedDispatcher(validatedAddresses);

      let res;
      try {
        res = await request(wh.url, {
        method: 'POST',
        dispatcher,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'MailPlatform-Webhooks/1.0',
          'X-MP-Signature': `t=${ts},v1=${signature}`,
          'X-MP-Event-Type': event_type,
        },
        body,
        bodyTimeout: TIMEOUT_MS,
        headersTimeout: TIMEOUT_MS,
        maxRedirections: 0, // never follow redirects — a 3xx could bounce us to an internal host
        });
      } catch (err: any) {
        const durationMs = Date.now() - startMs;
        const errorCode = typeof err?.code === 'string' ? err.code : 'request_failed';
        log.warn({ error_code: errorCode }, 'webhook request failed; will retry');
        webhookDeliveryDuration.observe(durationMs);
        webhookDeliveries.inc({ outcome: 'failure' });
        await logDelivery(
          webhook_id,
          event_id ?? null,
          event_type,
          attempt,
          'failure',
          durationMs,
          null,
          errorCode,
        ).catch(() => {});
        if (dispatcher) dispatcher.close().catch(() => dispatcher.destroy().catch(() => {}));
        throw err;
      }

      // Always drain the response body. undici keeps the connection pinned until
      // the body is consumed; skipping this leaks sockets and, under load,
      // exhausts the connection pool and stalls all webhook delivery.
      try {
        await res.body.dump();
      } catch {
        /* body already consumed / connection closed */
      }

      // Tear down the per-delivery pinned dispatcher (response is fully read by
      // now). Fire-and-forget close; never let cleanup mask the delivery result.
      if (dispatcher) dispatcher.close().catch(() => dispatcher.destroy().catch(() => {}));

      const durationMs = Date.now() - startMs;
      webhookDeliveryDuration.observe(durationMs);

      if (res.statusCode >= 200 && res.statusCode < 300) {
        log.info({ status: res.statusCode }, 'webhook delivered');
        webhookDeliveries.inc({ outcome: 'success' });
        await logDelivery(webhook_id, event_id ?? null, event_type, attempt, 'success', durationMs, res.statusCode, null).catch(() => {});
        return;
      }

      if (!isRetryableStatus(res.statusCode)) {
        // Permanent client error (e.g. 400/401/403/404/410) — retrying won't
        // help. Record and drop rather than wasting the retry budget.
        log.warn({ status: res.statusCode }, 'webhook returned non-retryable 4xx — dropping');
        webhookDeliveries.inc({ outcome: 'dropped' });
        await logDelivery(webhook_id, event_id ?? null, event_type, attempt, 'dropped', durationMs, res.statusCode, `HTTP ${res.statusCode}`).catch(() => {});
        return;
      }

      log.warn({ status: res.statusCode }, 'webhook returned retryable status — will retry');
      webhookDeliveries.inc({ outcome: 'failure' });
      await logDelivery(webhook_id, event_id ?? null, event_type, attempt, 'failure', durationMs, res.statusCode, `HTTP ${res.statusCode}`).catch(() => {});
      throw new Error(`Webhook returned ${res.statusCode}`);
    },
    {
      connection: redisOptions,
      concurrency: 20,
      settings: { backoffStrategy: webhookBackoffStrategy },
    }
  );

  // On retry exhaustion, dead-letter so a permanently failing endpoint is
  // observable instead of vanishing silently (parity with the send worker).
  worker.on('failed', async (job, err) => {
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts?.attempts ?? 1;
    if (job && attemptsMade >= maxAttempts) {
      logger.error({ job_id: job.id, webhook_id: job.data?.webhook_id, err: err.message, attemptsMade }, 'webhook job exhausted retries — dead-lettering');
      try {
        await deadLetter('webhooks', job, err.message);
        deadLetterTotal.inc({ source_queue: 'webhooks' });
      } catch (dlErr: any) {
        logger.error({ err: dlErr?.message }, 'failed to dead-letter webhook job');
      }
    } else {
      logger.warn({ job_id: job?.id, err: err.message, attemptsMade }, 'webhook job failed (will retry)');
    }
  });

  return worker;
}
