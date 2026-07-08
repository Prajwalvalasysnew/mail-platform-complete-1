/**
 * Official Node/TypeScript SDK for the mail platform API.
 *
 * Dependency-free (uses the global `fetch`, Node 18+). Construct a client with
 * your API key and call typed resource methods:
 *
 *   const mp = new MailPlatformClient({ apiKey: 'mpk_...' });
 *   await mp.messages.send({ from: 'you@yourdomain.com', to: 'a@b.com', subject: 'Hi', text: 'Hello' });
 *
 * A custom `fetch` can be injected (for testing, proxies, or custom transports).
 */

export interface MailPlatformClientOptions {
  apiKey: string;
  /** Base URL of the API, including the version prefix. Default: https://api.mailplatform.example/v1 */
  baseUrl?: string;
  /** Inject a custom fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch;
  /** Per-request timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Max automatic retries on 429/503 (default 3). */
  maxRetries?: number;
}

export class MailPlatformError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    const b = body as { error?: string; message?: string } | undefined;
    super(b?.message || b?.error || `Request failed with status ${status}`);
    this.name = 'MailPlatformError';
    this.status = status;
    this.code = b?.error;
    this.body = body;
  }
}

// ---- Public types ----------------------------------------------------------

export type EmailAddress = string;

export interface SendParams {
  from: EmailAddress;
  to: EmailAddress | EmailAddress[];
  subject?: string;
  html?: string;
  text?: string;
  reply_to?: EmailAddress;
  template_id?: string;
  variables?: Record<string, unknown>;
  tags?: string[];
  tracking_opens?: boolean;
  tracking_clicks?: boolean;
  /** Custom email headers (e.g. X-Entity-ID). Max 50 headers, 2 KB each. */
  headers?: Record<string, string>;
  /** Arbitrary metadata attached to the message and forwarded in webhook payloads. */
  metadata?: Record<string, unknown>;
  /** ISO-8601 timestamp: schedule delivery for a future time (max 30 days out). */
  send_at?: string;
  /** Sending priority 1 (highest) to 10 (lowest). */
  priority?: number;
  /** Named IP pool to use for this send. */
  ip_pool?: string;
  /** Dedupe key; a retry with the same key + body returns the original result. */
  idempotencyKey?: string;
}

export interface BatchSendParams {
  messages: SendParams[];
}

export interface SendResult {
  accepted: number;
  rejected: number;
  message_ids: string[];
  suppressed?: string[];
  scheduled_for?: string;
  status?: string;
}

export interface BatchSendResult {
  accepted: string[];
  rejected: Array<{ index: number; error: string }>;
}

export interface Suppression {
  email: string;
  reason: string;
  notes?: string | null;
  created_at: string;
}

export interface Domain {
  id: string;
  domain: string;
  verified_at: string | null;
  dkim_verified: boolean;
}

export interface Template {
  id: string;
  name: string;
  subject: string;
  html_body?: string | null;
  text_body?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  created_at?: string;
}

export interface WebhookDelivery {
  id: number;
  event_id: number | string;
  event_type: string;
  attempt: number;
  status_code: number | null;
  outcome: string;
  duration_ms: number | null;
  error: string | null;
  delivered_at: string;
}

export interface Message {
  message_id: string;
  from_address: string;
  to_address: string;
  subject: string;
  status: string;
  tags: string[];
  queued_at: string;
  accepted_at: string | null;
  delivered_at: string | null;
  bounced_at: string | null;
  opened_at: string | null;
  first_clicked_at: string | null;
  human_opened_at: string | null;
  human_clicked_at: string | null;
  attempts: number;
}

export interface UsageStats {
  daily: { used: number; limit: number; remaining: number; pct: number };
  monthly: { used: number; limit: number; remaining: number; pct: number };
  alerts: { daily_80: boolean; daily_100: boolean; monthly_80: boolean; monthly_100: boolean };
}

export interface UsageHistory {
  daily: Array<{ usage_date: string; sent: number; delivered: number; bounced: number; complained: number }>;
  totals: { sent: number; delivered: number; bounced: number; complained: number };
  rates: { delivery: number; bounce: number; complaint: number };
  health: { complaint_ok: boolean; bounce_ok: boolean };
}

export interface AnalyticsSummary {
  period: string;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
  delivery_rate: number;
  open_rate: number;
  click_rate: number;
}

export interface AnalyticsTimeseries {
  granularity: string;
  series: Array<{ date: string; sent: number; delivered: number; bounced: number; opened: number; clicked: number }>;
}

export interface AnalyticsBreakdownItem {
  key: string;
  sent: number;
  delivered: number;
  bounced: number;
  opened: number;
  clicked: number;
}

// ---- Client ----------------------------------------------------------------

const DEFAULT_BASE_URL = 'https://api.mailplatform.example/v1';

export class MailPlatformClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  readonly messages: MessagesResource;
  readonly suppressions: SuppressionsResource;
  readonly domains: DomainsResource;
  readonly templates: TemplatesResource;
  readonly webhooks: WebhooksResource;
  readonly usage: UsageResource;
  readonly analytics: AnalyticsResource;

  constructor(opts: MailPlatformClientOptions) {
    if (!opts.apiKey) throw new Error('MailPlatformClient: apiKey is required');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error('MailPlatformClient: no fetch available; pass options.fetch on Node < 18');
    this.fetchImpl = f;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;

    this.messages = new MessagesResource(this);
    this.suppressions = new SuppressionsResource(this);
    this.domains = new DomainsResource(this);
    this.templates = new TemplatesResource(this);
    this.webhooks = new WebhooksResource(this);
    this.usage = new UsageResource(this);
    this.analytics = new AnalyticsResource(this);
  }

  /** @internal */
  async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, unknown>; headers?: Record<string, string> } = {}
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null) qs.set(k, String(v));
      const s = qs.toString();
      if (s) url += `?${s}`;
    }

    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...opts.headers,
          },
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          signal: controller.signal,
        });
        const text = await res.text();
        const parsed = text ? safeJson(text) : undefined;

        // Retry on 429 or 503 up to maxRetries times.
        if ((res.status === 429 || res.status === 503) && attempt < this.maxRetries) {
          const retryAfterHeader = res.headers.get('retry-after');
          const delaySec = retryAfterHeader ? Number(retryAfterHeader) : 0;
          const delayMs = Number.isFinite(delaySec) && delaySec > 0
            ? delaySec * 1000
            : Math.min(500 * Math.pow(2, attempt), 16_000);
          attempt++;
          await sleep(delayMs);
          continue;
        }

        if (!res.ok) throw new MailPlatformError(res.status, parsed ?? text);
        return parsed as T;
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

// ---- Webhook signature verification ------------------------------------------

export interface VerifyWebhookOptions {
  /**
   * Maximum allowed age of the signature timestamp, in seconds. Rejects
   * replayed deliveries. Default: 300 (5 minutes). Set to 0 to disable
   * (not recommended).
   */
  toleranceSeconds?: number;
  /** Clock source, overridable for tests. Returns ms since epoch. */
  now?: () => number;
}

interface ParsedSignatureHeader {
  timestamp: number;
  signatures: string[];
}

/**
 * Parse the platform's `X-MP-Signature` header: `t=<unix seconds>,v1=<hex hmac>`.
 * Multiple `v1=` entries are allowed (secret-rotation windows).
 */
function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') {
      const n = Number(v);
      if (Number.isFinite(n)) timestamp = n;
    } else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) {
      signatures.push(v.toLowerCase());
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify the HMAC-SHA256 signature on an incoming webhook delivery.
 *
 * The platform signs `"{timestamp}.{rawBody}"` with your endpoint secret and
 * sends the result in the `X-MP-Signature` header as `t=<unix>,v1=<hex>`.
 *
 * @param payload   Raw request body (string — do NOT re-stringify parsed JSON).
 * @param header    The value of the `X-MP-Signature` header.
 * @param secret    Your webhook signing secret, or an array of secrets to
 *                  accept during rotation (current + previous).
 * @param options   Timestamp tolerance (default 300s).
 * @returns         `true` if any provided secret validates any `v1` signature
 *                  and the timestamp is within tolerance.
 *
 * @example
 * // Express — note express.raw so `payload` is the exact bytes we signed.
 * app.post('/webhook', express.raw({ type: '*\/*' }), (req, res) => {
 *   const ok = verifyWebhookSignature(
 *     req.body.toString('utf8'),
 *     req.headers['x-mp-signature'] as string,
 *     process.env.WEBHOOK_SECRET!,
 *   );
 *   if (!ok) return res.sendStatus(400);
 *   const event = JSON.parse(req.body.toString('utf8'));
 *   // handle event...
 *   res.sendStatus(200);
 * });
 */
export function verifyWebhookSignature(
  payload: string,
  header: string | undefined,
  secret: string | string[],
  options: VerifyWebhookOptions = {}
): boolean {
  if (!header) return false;
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter(Boolean);
  if (secrets.length === 0) return false;

  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  const tolerance = options.toleranceSeconds ?? 300;
  if (tolerance > 0) {
    const nowSec = (options.now ?? Date.now)() / 1000;
    if (Math.abs(nowSec - parsed.timestamp) > tolerance) return false;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHmac } = require('node:crypto') as typeof import('crypto');
    const signedPayload = `${parsed.timestamp}.${payload}`;
    let valid = false;
    for (const s of secrets) {
      const expected = createHmac('sha256', s).update(signedPayload).digest('hex');
      for (const candidate of parsed.signatures) {
        // No early return: evaluate every combination for constant-ish timing.
        if (constantTimeHexEqual(candidate, expected)) valid = true;
      }
    }
    return valid;
  } catch {
    return false;
  }
}

/**
 * Async version of {@link verifyWebhookSignature} that uses the Web Crypto API
 * (SubtleCrypto). Works in browser, Cloudflare Workers, and Deno without
 * `node:crypto`. Same header format: `X-MP-Signature: t=<unix>,v1=<hex>`.
 */
export async function verifyWebhookSignatureAsync(
  payload: string,
  header: string | undefined,
  secret: string | string[],
  options: VerifyWebhookOptions = {}
): Promise<boolean> {
  if (!header) return false;
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter(Boolean);
  if (secrets.length === 0) return false;

  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  const tolerance = options.toleranceSeconds ?? 300;
  if (tolerance > 0) {
    const nowSec = (options.now ?? Date.now)() / 1000;
    if (Math.abs(nowSec - parsed.timestamp) > tolerance) return false;
  }

  const enc = new TextEncoder();
  try {
    const signedPayload = `${parsed.timestamp}.${payload}`;
    let valid = false;
    for (const s of secrets) {
      const key = await globalThis.crypto.subtle.importKey(
        'raw',
        enc.encode(s),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
      const expected = Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      for (const candidate of parsed.signatures) {
        if (constantTimeHexEqual(candidate, expected)) valid = true;
      }
    }
    return valid;
  } catch {
    return false;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Resources -------------------------------------------------------------

class MessagesResource {
  constructor(private readonly c: MailPlatformClient) {}

  send(params: SendParams): Promise<SendResult> {
    const { idempotencyKey, ...body } = params;
    return this.c.request<SendResult>('POST', '/send', {
      body,
      ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
    });
  }

  sendBatch(params: BatchSendParams): Promise<BatchSendResult> {
    return this.c.request<BatchSendResult>('POST', '/send/batch', { body: params });
  }

  get(messageId: string): Promise<{ message: Message; events: unknown[] }> {
    return this.c.request('GET', `/messages/${encodeURIComponent(messageId)}`);
  }

  list(query: {
    limit?: number; cursor?: string; status?: string; tag?: string;
    to?: string; from_address?: string; since?: string; until?: string;
  } = {}): Promise<{ messages: Message[]; next_cursor?: string }> {
    return this.c.request('GET', '/messages', { query });
  }

  listScheduled(query: { limit?: number; cursor?: string } = {}): Promise<{ messages: Message[]; next_cursor?: string }> {
    return this.c.request('GET', '/messages', { query: { ...query, status: 'scheduled' } });
  }

  cancelScheduled(messageId: string): Promise<{ cancelled: boolean }> {
    return this.c.request('DELETE', `/messages/${encodeURIComponent(messageId)}/cancel`);
  }

  activity(query: Record<string, unknown> = {}): Promise<unknown> {
    return this.c.request('GET', '/messages/activity', { query });
  }
}

class SuppressionsResource {
  constructor(private readonly c: MailPlatformClient) {}

  list(query: { limit?: number; offset?: number; reason?: string } = {}): Promise<{ suppressions: Suppression[] }> {
    return this.c.request('GET', '/suppressions', { query });
  }

  add(email: string, reason?: string): Promise<{ email: string }> {
    return this.c.request('POST', '/suppressions', { body: { email, reason } });
  }

  remove(email: string): Promise<void> {
    return this.c.request('DELETE', `/suppressions/${encodeURIComponent(email)}`);
  }

  import(params: { emails: string[]; reason?: string; force?: boolean }): Promise<{ imported: number; quality: unknown }> {
    return this.c.request('POST', '/suppressions/import', { body: params });
  }

  export(params: { format?: 'csv' | 'ndjson'; since?: string } = {}): Promise<unknown> {
    return this.c.request('GET', '/suppressions/export', { query: params });
  }
}

class DomainsResource {
  constructor(private readonly c: MailPlatformClient) {}

  list(): Promise<{ domains: Domain[] }> {
    return this.c.request('GET', '/domains');
  }

  add(domain: string): Promise<Domain> {
    return this.c.request('POST', '/domains', { body: { domain } });
  }

  verify(id: string): Promise<Domain> {
    return this.c.request('POST', `/domains/${encodeURIComponent(id)}/verify`);
  }

  remove(id: string): Promise<void> {
    return this.c.request('DELETE', `/domains/${encodeURIComponent(id)}`);
  }
}

class TemplatesResource {
  constructor(private readonly c: MailPlatformClient) {}

  list(): Promise<{ templates: Template[] }> {
    return this.c.request('GET', '/templates');
  }

  get(id: string): Promise<Template> {
    return this.c.request('GET', `/templates/${encodeURIComponent(id)}`);
  }

  create(body: { name: string; subject: string; html_body?: string; text_body?: string }): Promise<Template> {
    return this.c.request('POST', '/templates', { body });
  }

  update(id: string, body: Partial<{ name: string; subject: string; html_body: string; text_body: string }>): Promise<Template> {
    return this.c.request('PUT', `/templates/${encodeURIComponent(id)}`, { body });
  }

  remove(id: string): Promise<void> {
    return this.c.request('DELETE', `/templates/${encodeURIComponent(id)}`);
  }
}

class WebhooksResource {
  constructor(private readonly c: MailPlatformClient) {}

  list(): Promise<{ webhooks: Webhook[] }> {
    return this.c.request('GET', '/webhooks');
  }

  create(body: { url: string; events: string[] }): Promise<Webhook> {
    return this.c.request('POST', '/webhooks', { body });
  }

  remove(id: string): Promise<void> {
    return this.c.request('DELETE', `/webhooks/${encodeURIComponent(id)}`);
  }

  rotateSecret(id: string): Promise<Webhook & { signing_secret: string }> {
    return this.c.request('POST', `/webhooks/${encodeURIComponent(id)}/rotate-secret`);
  }

  listDeliveries(
    id: string,
    params: { limit?: number; before?: number } = {}
  ): Promise<{ deliveries: WebhookDelivery[]; next_cursor?: number }> {
    return this.c.request('GET', `/webhooks/${encodeURIComponent(id)}/deliveries`, { query: params });
  }

  testPing(id: string): Promise<{ queued: true }> {
    return this.c.request('POST', `/webhooks/${encodeURIComponent(id)}/test`);
  }

  retryFailures(id: string, params: { since?: string; limit?: number } = {}): Promise<{ retried: number }> {
    return this.c.request('POST', `/webhooks/${encodeURIComponent(id)}/retry-failures`, { body: params });
  }
}

class UsageResource {
  constructor(private readonly c: MailPlatformClient) {}

  quota(): Promise<UsageStats> {
    return this.c.request<UsageStats>('GET', '/usage/quota');
  }

  history(params: { days?: number } = {}): Promise<UsageHistory> {
    return this.c.request<UsageHistory>('GET', '/usage', { query: params });
  }

  stats(params: { days?: number } = {}): Promise<{ stats: Array<{ event_type: string; count: number }> }> {
    return this.c.request('GET', '/stats', { query: params });
  }
}

class AnalyticsResource {
  constructor(private readonly c: MailPlatformClient) {}

  summary(params: { period?: '24h' | '7d' | '30d' } = {}): Promise<AnalyticsSummary> {
    return this.c.request<AnalyticsSummary>('GET', '/analytics/summary', { query: params });
  }

  timeseries(params: { period?: '7d' | '30d'; granularity?: 'hour' | 'day' } = {}): Promise<AnalyticsTimeseries> {
    return this.c.request<AnalyticsTimeseries>('GET', '/analytics/timeseries', { query: params });
  }

  breakdown(params: { by: 'tag' | 'domain' | 'template'; period?: '7d' | '30d' }): Promise<{ items: AnalyticsBreakdownItem[] }> {
    return this.c.request('GET', '/analytics/breakdown', { query: params });
  }
}
