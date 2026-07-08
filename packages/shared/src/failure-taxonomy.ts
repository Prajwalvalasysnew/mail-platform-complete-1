// Provider failure taxonomy (gap analysis Top-20 #14).
//
// The base transport only split failures into permanent vs transient off a
// crude 5xx check. Real ISP-grade retry shaping needs finer classification: a
// 421 rate-limit, a 451 greylist, a 452 mailbox-full, a 550 5.1.1 bad-recipient,
// and a 550 5.7.1 reputation block all demand DIFFERENT handling even though
// several are "5xx" or "4xx". This module classifies an SMTP/ESP failure into a
// category with a recommended retry strategy, from the response code, the
// RFC-3463 enhanced status code, and provider-specific message patterns.
//
// Pure functions, no I/O — fully unit-testable.

export type FailureCategory =
  | 'invalid_recipient'      // 5.1.x — address doesn't exist; permanent, suppress
  | 'mailbox_full'           // 4.2.2 / 452 — over quota; transient, retry later
  | 'message_too_large'      // 5.3.4 / 552 — permanent for this message
  | 'rate_limited'           // 421 / 4.7.x throttle — back off aggressively
  | 'greylisted'             // 451 4.7.1 — retry soon, expected to pass
  | 'reputation_block'       // 5.7.1 / policy — IP/domain blocked; needs remediation
  | 'auth_failure'           // 5.7.8 / 530 — sender auth (SPF/DKIM/DMARC) rejected
  | 'content_rejected'       // 5.7.1 spam content / 554 — content flagged
  | 'connection_failure'     // network/TLS/timeout — transient infra
  | 'temporary_failure'      // generic 4xx
  | 'permanent_failure'      // generic 5xx
  | 'unknown';

export type RetryStrategy =
  | 'no_retry'               // permanent; do not retry (optionally suppress)
  | 'retry_fast'             // greylist etc. — short delay, expected success
  | 'retry_backoff'          // standard exponential backoff
  | 'retry_slow'             // rate-limited/reputation — long delay, reduced rate
  | 'retry_after_remediation'; // needs operator action (auth/reputation) — retry sparingly

export interface FailureClassification {
  category: FailureCategory;
  strategy: RetryStrategy;
  permanent: boolean;
  /** Should the recipient be added to the suppression list as a hard bounce? */
  suppress: boolean;
  /** SMTP response code (e.g. 421, 550) if parsed. */
  code?: number;
  /** RFC 3463 enhanced status (e.g. "5.1.1") if present. */
  enhanced?: string;
  /** Human-readable reason for logs/observability. */
  reason: string;
}

const ENHANCED_RE = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;

export interface ClassifyInput {
  /** SMTP response code, if the transport surfaced one (responseCode/code). */
  code?: number | string;
  /** Full SMTP response text / error message. */
  response?: string;
  /** Provider name, for provider-specific patterns (e.g. 'ses'). */
  provider?: string;
}

/**
 * Classify a delivery failure into a category + retry strategy.
 *
 * Precedence: specific enhanced-status / message patterns first (they carry the
 * most intent), then the numeric code class, then a safe default.
 */
export function classifyFailure(input: ClassifyInput): FailureClassification {
  const response = (input.response ?? '').toString();
  const lower = response.toLowerCase();
  const numCode = typeof input.code === 'number' ? input.code
    : typeof input.code === 'string' && /^\d{3}$/.test(input.code) ? parseInt(input.code, 10)
    : parseLeadingCode(response);
  const enhancedMatch = ENHANCED_RE.exec(response);
  const enhanced = enhancedMatch ? `${enhancedMatch[1]}.${enhancedMatch[2]}.${enhancedMatch[3]}` : undefined;
  const enhancedClass = enhancedMatch ? Number(enhancedMatch[1]) : undefined;

  const make = (category: FailureCategory, strategy: RetryStrategy, permanent: boolean, suppress: boolean, reason: string): FailureClassification =>
    ({ category, strategy, permanent, suppress, code: numCode, enhanced, reason });

  // ── Message-pattern signals (highest intent) ──────────────────────────────
  // Greylisting first — its messages often also contain "try again later",
  // which would otherwise be captured by the rate-limit pattern below. Greylist
  // is specifically a 451/4.7.1 transient defer.
  if (/greylist|grey list|temporarily deferred/i.test(lower) || (/4\.7\.1/.test(response) && /(defer|try again|retry)/i.test(lower))) {
    return make('greylisted', 'retry_fast', false, false, 'Greylisted — retry shortly');
  }
  // Rate limiting — many ISPs use 421/450 with throttle language.
  if (/rate limit|too many|throttl|slow down|exceeded.*(sending|rate)|4\.7\.28|4\.7\.65/i.test(response) || (/try again later/i.test(lower) && numCode === 421)) {
    return make('rate_limited', 'retry_slow', false, false, 'ISP rate limiting / throttling');
  }
  // Reputation / blocklist.
  if (/blocked|blacklist|blocklist|poor reputation|spamhaus|barracuda|spfbl|listed (on|in)|5\.7\.1.*(block|reput)/i.test(lower)) {
    return make('reputation_block', 'retry_after_remediation', false, false, 'IP/domain reputation block');
  }
  // Sender authentication (SPF/DKIM/DMARC).
  if (/spf|dkim|dmarc|5\.7\.8|5\.7\.26|not authorized to send|sender.*(reject|not allowed)/i.test(lower)) {
    return make('auth_failure', 'retry_after_remediation', true, false, 'Sender authentication (SPF/DKIM/DMARC) failure');
  }
  // Spam/content rejection.
  if (/spam|content.*(reject|block)|message rejected.*content|5\.7\.1.*(spam|content)|554.*reject/i.test(lower)) {
    return make('content_rejected', 'retry_after_remediation', true, false, 'Content flagged as spam');
  }
  // Mailbox full / over quota.
  if (/mailbox full|over quota|quota exceeded|4\.2\.2|insufficient.*storage|452.*(full|quota)/i.test(lower)) {
    return make('mailbox_full', 'retry_backoff', false, false, 'Recipient mailbox full / over quota');
  }
  // Message too large.
  if (/message (size|too (large|big))|exceeds.*size limit|5\.3\.4|552/i.test(lower)) {
    return make('message_too_large', 'no_retry', true, false, 'Message exceeds size limit');
  }
  // Invalid recipient — the classic hard bounce that should suppress.
  if (/no such user|user unknown|does not exist|invalid recipient|recipient.*(rejected|not found)|mailbox unavailable|5\.1\.1|5\.1\.0|550.*(unknown|no such)/i.test(lower)) {
    return make('invalid_recipient', 'no_retry', true, true, 'Recipient address does not exist');
  }

  // ── Enhanced status code class ────────────────────────────────────────────
  if (enhanced) {
    if (enhancedClass === 5) {
      // Permanent enhanced status; 5.1.x already handled above.
      return make('permanent_failure', 'no_retry', true, /^5\.1\./.test(enhanced), `Permanent failure (${enhanced})`);
    }
    if (enhancedClass === 4) {
      return make('temporary_failure', 'retry_backoff', false, false, `Temporary failure (${enhanced})`);
    }
  }

  // ── Numeric SMTP code class ───────────────────────────────────────────────
  if (typeof numCode === 'number') {
    if (numCode === 421) return make('rate_limited', 'retry_slow', false, false, 'Service not available / throttled (421)');
    if (numCode === 451) return make('greylisted', 'retry_fast', false, false, 'Local error / greylist (451)');
    if (numCode === 452) return make('mailbox_full', 'retry_backoff', false, false, 'Insufficient storage (452)');
    if (numCode === 550) return make('invalid_recipient', 'no_retry', true, true, 'Mailbox unavailable (550)');
    if (numCode === 552) return make('message_too_large', 'no_retry', true, false, 'Storage/size limit (552)');
    if (numCode === 554) return make('content_rejected', 'retry_after_remediation', true, false, 'Transaction failed (554)');
    if (numCode >= 500 && numCode < 600) return make('permanent_failure', 'no_retry', true, false, `Permanent SMTP failure (${numCode})`);
    if (numCode >= 400 && numCode < 500) return make('temporary_failure', 'retry_backoff', false, false, `Temporary SMTP failure (${numCode})`);
  }

  // ── Connection-level (no SMTP code at all) ────────────────────────────────
  if (/etimedout|econnrefused|econnreset|ehostunreach|enotfound|socket|tls|handshake|timeout|network/i.test(lower)) {
    return make('connection_failure', 'retry_backoff', false, false, 'Connection/network failure');
  }

  return make('unknown', 'retry_backoff', false, false, 'Unclassified failure');
}

function parseLeadingCode(response: string): number | undefined {
  const m = /^\s*(\d{3})\b/.exec(response);
  return m && m[1] ? parseInt(m[1], 10) : undefined;
}

/**
 * Map a retry strategy to a concrete next-attempt delay (ms) for a given
 * attempt number (1-based). Used by the send worker to shape backoff per
 * category rather than a single global curve.
 */
export function retryDelayMs(strategy: RetryStrategy, attempt: number): number | null {
  const a = Math.max(1, attempt);
  switch (strategy) {
    case 'no_retry':
      return null;
    case 'retry_fast':
      // Greylist: short, near-constant (1m, 2m, 4m…), capped at 15m.
      return Math.min(60_000 * 2 ** (a - 1), 15 * 60_000);
    case 'retry_backoff':
      // Standard exponential: 1m, 5m, 25m… capped at 2h.
      return Math.min(60_000 * 5 ** (a - 1), 2 * 60 * 60_000);
    case 'retry_slow':
      // Rate-limited/reputation: long, 30m, 1h, 2h… capped at 6h.
      return Math.min(30 * 60_000 * 2 ** (a - 1), 6 * 60 * 60_000);
    case 'retry_after_remediation':
      // Needs operator action; retry sparingly: 1h, 3h, 6h… capped at 12h.
      return Math.min(60 * 60_000 * 3 ** (a - 1), 12 * 60 * 60_000);
    default:
      return Math.min(60_000 * 5 ** (a - 1), 2 * 60 * 60_000);
  }
}
