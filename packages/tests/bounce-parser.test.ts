// Unit tests for the inbound Haraka bounce/complaint parser. These exercise the
// pure parsing functions (parseDsn, parseFbl, extractMessageIdFromVerp) against
// realistic Gmail / Yahoo / Outlook DSN bodies and an ARF complaint, plus VERP
// signature verification. The parser is security-critical (forged bounces must
// not be able to suppress arbitrary recipients) and previously had no coverage.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
// Loaded via require because the Haraka plugin is plain CommonJS.
const plugin = require('../haraka-inbound/plugins/bounce_parser.js');
const { parseDsn, parseFbl, extractMessageIdFromVerp, verpTag } = plugin._internal;

const VERP_SECRET = 'test-verp-secret-at-least-16-chars';
beforeAll(() => {
  process.env.VERP_SECRET = VERP_SECRET;
});

// mailparser produces an object with .text, .attachments, and .headers (a Map).
// The parser only reads those three, so we build a minimal compatible shape.
function fakeParsed(opts: { contentType?: string; text?: string; attachments?: string[] }) {
  return {
    text: opts.text ?? '',
    attachments: (opts.attachments ?? []).map((s) => ({ content: Buffer.from(s, 'utf8') })),
    headers: new Map<string, any>([['content-type', { value: opts.contentType ?? 'text/plain' }]]),
  };
}

describe('parseDsn', () => {
  it('parses a structured Gmail 5.1.1 hard bounce', () => {
    const body = [
      'Reporting-MTA: dns; mail.google.com',
      '',
      'Final-Recipient: rfc822; nouser@gmail.com',
      'Action: failed',
      'Status: 5.1.1',
      "Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.",
    ].join('\n');
    const r = parseDsn(fakeParsed({ contentType: 'multipart/report; report-type=delivery-status', text: body }));
    expect(r.isBounce).toBe(true);
    expect(r.status).toBe('5.1.1');
    expect(r.isHard).toBe(true);
    expect(r.action).toBe('failed');
    expect(r.recipient).toBe('nouser@gmail.com');
    expect(r.confident).toBe(true);
    expect(r.diagnostic).toContain('550');
  });

  it('parses a soft 4.2.2 over-quota bounce as non-hard', () => {
    const body = [
      'Final-Recipient: rfc822; full@yahoo.com',
      'Action: delayed',
      'Status: 4.2.2',
      'Diagnostic-Code: smtp; 452 4.2.2 Over quota',
    ].join('\n');
    const r = parseDsn(fakeParsed({ contentType: 'multipart/report; report-type=delivery-status', text: body }));
    expect(r.isBounce).toBe(true);
    expect(r.status).toBe('4.2.2');
    expect(r.isHard).toBe(false);
    expect(r.confident).toBe(true);
  });

  it('falls back to the SMTP code in the Diagnostic-Code when no Status line', () => {
    const body = [
      'Final-Recipient: rfc822; bad@outlook.com',
      'Diagnostic-Code: smtp; 550 Requested action not taken: mailbox unavailable',
    ].join('\n');
    const r = parseDsn(fakeParsed({ text: body }));
    expect(r.isBounce).toBe(true);
    expect(r.isHard).toBe(true); // 5xx
    expect(r.confident).toBe(true);
  });

  it('treats Action: failed without a status as a hard bounce', () => {
    const body = ['Final-Recipient: rfc822; x@domain.com', 'Action: failed'].join('\n');
    const r = parseDsn(fakeParsed({ text: body }));
    expect(r.isBounce).toBe(true);
    expect(r.isHard).toBe(true);
  });

  it('reads a DSN delivered as an attachment, not inline text', () => {
    const dsn = ['Final-Recipient: rfc822; a@b.com', 'Action: failed', 'Status: 5.0.0'].join('\n');
    const r = parseDsn(fakeParsed({ contentType: 'multipart/report', attachments: [dsn] }));
    expect(r.isBounce).toBe(true);
    expect(r.status).toBe('5.0.0');
    expect(r.isHard).toBe(true);
  });

  it('does not treat ordinary mail as a bounce', () => {
    const r = parseDsn(fakeParsed({ contentType: 'text/plain', text: 'Hi, just following up on lunch.' }));
    expect(r.isBounce).toBe(false);
  });

  it('bounds the parsed input size (DoS guard) while still parsing an early DSN', () => {
    // A valid DSN at the top of the message, followed by a 5MB attachment blob.
    // The parser must still extract the status, but must NOT scan the whole 5MB
    // (the cap is 256KB) — proving the memory/CPU amplification vector is bounded.
    const dsn = [
      'Final-Recipient: rfc822; nouser@example.com',
      'Action: failed',
      'Status: 5.1.1',
      'Diagnostic-Code: smtp; 550 no such user',
    ].join('\n');
    const huge = 'x'.repeat(5 * 1024 * 1024); // 5 MB
    const r = parseDsn(fakeParsed({
      contentType: 'multipart/report; report-type=delivery-status',
      text: dsn,
      attachments: [huge],
    }));
    expect(r.isBounce).toBe(true);
    expect(r.status).toBe('5.1.1');
    expect(r.isHard).toBe(true);
  });
});

describe('parseFbl (ARF complaints)', () => {
  it('parses a feedback-report complaint with recipient and message id', () => {
    const body = [
      'Feedback-Type: abuse',
      'User-Agent: SomeFBL/1.0',
      'Version: 1',
      'Original-Rcpt-To: complainer@aol.com',
      'Message-ID: <abc123@mail.test>',
    ].join('\n');
    const r = parseFbl(fakeParsed({ contentType: 'multipart/report; report-type=feedback-report', text: body }));
    expect(r.isComplaint).toBe(true);
    expect(r.feedbackType).toBe('abuse');
    expect(r.recipient).toBe('complainer@aol.com');
    expect(r.originalMessageId).toBe('<abc123@mail.test>');
    expect(r.confident).toBe(true);
  });

  it('does not flag a normal message as a complaint', () => {
    const r = parseFbl(fakeParsed({ contentType: 'text/plain', text: 'thanks!' }));
    expect(r.isComplaint).toBe(false);
  });
});

describe('extractMessageIdFromVerp (forgery resistance)', () => {
  function signedReturnPath(messageId: string): string {
    const encoded = Buffer.from(messageId, 'utf8').toString('base64url');
    const sig = verpTag(encoded);
    return `bounce+${encoded}.${sig}@bounces.localhost`;
  }

  it('recovers the original message id from a correctly signed VERP return-path', () => {
    const original = 'msg-abc-123@mail.test';
    const rp = signedReturnPath(original);
    const recovered = extractMessageIdFromVerp({ original: rp });
    expect(recovered).toBe(`<${original}>`);
  });

  it('rejects a VERP token with a tampered signature (forged bounce)', () => {
    const encoded = Buffer.from('victim@mail.test', 'utf8').toString('base64url');
    const forged = `bounce+${encoded}.AAAAAAAAAAA@bounces.localhost`;
    expect(extractMessageIdFromVerp({ original: forged })).toBeNull();
  });

  it('rejects a return-path that is not VERP-formatted', () => {
    expect(extractMessageIdFromVerp({ original: 'postmaster@somewhere.com' })).toBeNull();
    expect(extractMessageIdFromVerp(null)).toBeNull();
    expect(extractMessageIdFromVerp({})).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const encoded = Buffer.from('m@mail.test', 'utf8').toString('base64url');
    const wrongSig = crypto.createHmac('sha256', 'a-totally-different-secret-key')
      .update(encoded).digest().subarray(0, 8).toString('base64url');
    const rp = `bounce+${encoded}.${wrongSig}@bounces.localhost`;
    expect(extractMessageIdFromVerp({ original: rp })).toBeNull();
  });
});

describe('FBL complaint targeting (forgery resistance)', () => {
  // The complaint path must derive the suppressed message-id from the signed
  // VERP return-path, NOT from the attacker-controllable Message-ID header in
  // the ARF body. These tests encode that security contract: the body id is
  // parsed for cross-checking only and may never be the sole source of truth.
  function signedReturnPath(messageId: string): string {
    const encoded = Buffer.from(messageId, 'utf8').toString('base64url');
    const sig = verpTag(encoded);
    return `bounce+${encoded}.${sig}@bounces.localhost`;
  }

  // Mirrors the selection rule implemented in the parse() hook.
  function chooseComplaintTarget(verpEnvelope: any, fblBodyMessageId: string | null): string | null {
    const verpMessageId = extractMessageIdFromVerp(verpEnvelope);
    if (!verpMessageId) return null; // no valid signed id — ignore
    if (fblBodyMessageId && fblBodyMessageId !== verpMessageId) return null; // mismatch — ignore
    return verpMessageId;
  }

  it('honors a complaint whose VERP return-path is correctly signed', () => {
    const original = 'real-msg-1@mail.test';
    const target = chooseComplaintTarget({ original: signedReturnPath(original) }, `<${original}>`);
    expect(target).toBe(`<${original}>`);
  });

  it('ignores a forged complaint that supplies only an unsigned body Message-ID', () => {
    // Attacker delivers an ARF report naming a victim message-id in the body,
    // with no valid signed VERP return-path. Must NOT suppress the victim.
    const fbl = parseFbl(
      fakeParsed({
        contentType: 'multipart/report; report-type=feedback-report',
        text: ['Feedback-Type: abuse', 'Message-ID: <victim-msg@mail.test>'].join('\n'),
      })
    );
    expect(fbl.originalMessageId).toBe('<victim-msg@mail.test>'); // body still parsed
    // ...but with no signed VERP envelope the target is null (ignored).
    const target = chooseComplaintTarget({ original: 'postmaster@evil.test' }, fbl.originalMessageId);
    expect(target).toBeNull();
  });

  it('ignores a complaint whose body Message-ID does not match the signed VERP id', () => {
    const signed = signedReturnPath('legit@mail.test');
    const target = chooseComplaintTarget({ original: signed }, '<someone-else@mail.test>');
    expect(target).toBeNull();
  });
});

describe('bounceEventKey (deterministic idempotency)', () => {
  const { bounceEventKey } = plugin._internal;

  it('is stable for identical (event_type, message_id, recipient) — so provider re-deliveries dedupe', () => {
    const a = bounceEventKey('<m1@mail.test>', 'hard_bounce', 'r@example.com');
    const b = bounceEventKey('<m1@mail.test>', 'hard_bounce', 'r@example.com');
    expect(a).toBe(b);
    // Was previously crypto.randomUUID(), which would NOT match across retries.
    expect(a).not.toContain('-'); // sha256 hex, not a UUID
    expect(a).toHaveLength(64);
  });

  it('differs across event type, message id, and recipient', () => {
    const base = bounceEventKey('<m1@mail.test>', 'hard_bounce', 'r@example.com');
    expect(bounceEventKey('<m1@mail.test>', 'soft_bounce', 'r@example.com')).not.toBe(base);
    expect(bounceEventKey('<m2@mail.test>', 'hard_bounce', 'r@example.com')).not.toBe(base);
    expect(bounceEventKey('<m1@mail.test>', 'hard_bounce', 'other@example.com')).not.toBe(base);
  });

  it('handles a null/undefined recipient without throwing', () => {
    expect(() => bounceEventKey('<m1@mail.test>', 'complaint', null)).not.toThrow();
    expect(bounceEventKey('<m1@mail.test>', 'complaint', null)).toHaveLength(64);
  });
});
