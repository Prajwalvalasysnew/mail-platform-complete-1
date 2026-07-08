// Unit tests for the provider failure taxonomy (gap analysis Top-20 #14).
// Pure classification logic — no DB. Verifies that real-world SMTP/ESP failure
// responses map to the right category + retry strategy, which is what drives
// ISP-grade retry shaping.

import { describe, it, expect } from 'vitest';
import { classifyFailure, retryDelayMs } from '@platform/shared';

describe('classifyFailure', () => {
  it('classifies invalid recipient as permanent + suppress', () => {
    const c = classifyFailure({ code: 550, response: '550 5.1.1 <nobody@x.com>: Recipient address rejected: User unknown' });
    expect(c.category).toBe('invalid_recipient');
    expect(c.strategy).toBe('no_retry');
    expect(c.permanent).toBe(true);
    expect(c.suppress).toBe(true);
    expect(c.enhanced).toBe('5.1.1');
  });

  it('classifies 421 throttling as rate_limited + retry_slow (not permanent)', () => {
    const c = classifyFailure({ code: 421, response: '421 4.7.0 Too many messages, slow down' });
    expect(c.category).toBe('rate_limited');
    expect(c.strategy).toBe('retry_slow');
    expect(c.permanent).toBe(false);
    expect(c.suppress).toBe(false);
  });

  it('classifies greylisting as retry_fast', () => {
    const c = classifyFailure({ code: 451, response: '451 4.7.1 Greylisted, please try again later' });
    expect(c.category).toBe('greylisted');
    expect(c.strategy).toBe('retry_fast');
    expect(c.permanent).toBe(false);
  });

  it('classifies mailbox full as transient retry_backoff', () => {
    const c = classifyFailure({ code: 452, response: '452 4.2.2 The email account that you tried to reach is over quota' });
    expect(c.category).toBe('mailbox_full');
    expect(c.strategy).toBe('retry_backoff');
    expect(c.permanent).toBe(false);
  });

  it('classifies reputation blocks as retry_after_remediation (NOT plain permanent)', () => {
    const c = classifyFailure({ code: 554, response: '554 5.7.1 Service unavailable; Client host blocked using Spamhaus' });
    expect(c.category).toBe('reputation_block');
    expect(c.strategy).toBe('retry_after_remediation');
    // Reputation blocks are recoverable after remediation, so NOT marked permanent
    // even though the code is 5xx — this is the key improvement over the old logic.
    expect(c.permanent).toBe(false);
  });

  it('classifies SPF/DKIM/DMARC auth failures', () => {
    const c = classifyFailure({ code: 550, response: '550 5.7.26 Unauthenticated email is not accepted (SPF/DKIM failed)' });
    expect(c.category).toBe('auth_failure');
    expect(c.strategy).toBe('retry_after_remediation');
  });

  it('classifies spam content rejection', () => {
    const c = classifyFailure({ code: 554, response: '554 5.7.1 Message rejected as spam by content filter' });
    expect(c.category).toBe('content_rejected');
  });

  it('classifies message too large as no_retry', () => {
    const c = classifyFailure({ code: 552, response: '552 5.3.4 Message size exceeds fixed maximum message size' });
    expect(c.category).toBe('message_too_large');
    expect(c.strategy).toBe('no_retry');
    expect(c.permanent).toBe(true);
  });

  it('classifies connection-level failures (no SMTP code) as transient', () => {
    const c = classifyFailure({ code: 'ETIMEDOUT', response: 'connect ETIMEDOUT 10.0.0.1:25' });
    expect(c.category).toBe('connection_failure');
    expect(c.strategy).toBe('retry_backoff');
    expect(c.permanent).toBe(false);
  });

  it('falls back to generic permanent for an unrecognized 5xx', () => {
    const c = classifyFailure({ code: 501, response: '501 Syntax error' });
    expect(c.category).toBe('permanent_failure');
    expect(c.permanent).toBe(true);
  });

  it('falls back to generic temporary for an unrecognized 4xx', () => {
    const c = classifyFailure({ code: 450, response: '450 Requested action not taken' });
    expect(c.category).toBe('temporary_failure');
    expect(c.permanent).toBe(false);
  });

  it('parses the SMTP code from the response text when code is absent', () => {
    const c = classifyFailure({ response: '550 5.1.1 user unknown' });
    expect(c.code).toBe(550);
    expect(c.category).toBe('invalid_recipient');
  });

  it('handles a completely unknown error safely', () => {
    const c = classifyFailure({ response: 'something weird happened' });
    expect(c.category).toBe('unknown');
    expect(c.strategy).toBe('retry_backoff');
    expect(c.permanent).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('returns null for no_retry', () => {
    expect(retryDelayMs('no_retry', 1)).toBeNull();
  });

  it('greylist retry_fast is short and increasing, capped at 15m', () => {
    expect(retryDelayMs('retry_fast', 1)).toBe(60_000);
    expect(retryDelayMs('retry_fast', 2)).toBe(120_000);
    expect(retryDelayMs('retry_fast', 20)).toBe(15 * 60_000); // capped
  });

  it('rate_limited retry_slow is longer than standard backoff', () => {
    expect(retryDelayMs('retry_slow', 1)).toBeGreaterThan(retryDelayMs('retry_backoff', 1)!);
    expect(retryDelayMs('retry_slow', 20)).toBe(6 * 60 * 60_000); // capped at 6h
  });

  it('retry_after_remediation is the most conservative and caps at 12h', () => {
    expect(retryDelayMs('retry_after_remediation', 1)).toBe(60 * 60_000);
    expect(retryDelayMs('retry_after_remediation', 20)).toBe(12 * 60 * 60_000);
  });

  it('standard backoff caps at 2h', () => {
    expect(retryDelayMs('retry_backoff', 20)).toBe(2 * 60 * 60_000);
  });
});
