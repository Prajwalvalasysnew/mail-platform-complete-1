import { describe, expect, it } from 'vitest';
import { parseDsnText, parseArfText } from '@platform/shared';

// A corpus of real-world bounce variations. Real DSNs are wildly inconsistent —
// these fixtures capture the formats we've actually seen in production.

const GMAIL_HARD = `
This is the mail system at host mx.google.com.

I'm sorry to have to inform you that your message could not
be delivered to one or more recipients.

--- delivery report ---
Reporting-MTA: dns; mx.google.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.
Final-Recipient: rfc822; nobody@example.com
`;

const YAHOO_SOFT = `
Reporting-MTA: dns; mta1.am0.yahoodns.net
Final-Recipient: rfc822;recipient@yahoo.com
Action: delayed
Status: 4.2.2
Diagnostic-Code: smtp; 421 4.2.2 Mailbox full
`;

const MICROSOFT_NO_STATUS = `
Diagnostic-Code: smtp; 550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup
Final-Recipient: rfc822; user@outlook.com
Action: failed
`;

const ARF_COMPLAINT = `
Feedback-Type: abuse
User-Agent: AOL Feedback Loop 1.0
Version: 1
Original-Mail-From: <sender@example.com>
Original-Rcpt-To: complainer@aol.com
Message-ID: <abc123@example.com>
Source-IP: 192.0.2.10
Arrival-Date: Mon, 1 Jan 2025 10:00:00 +0000
`;

const NOT_A_BOUNCE = `
Subject: Hello there
This is a regular email.
`;

describe('parseDsnText', () => {
  it('parses Gmail-style hard bounce with structured Status', () => {
    const r = parseDsnText('multipart/report; report-type=delivery-status', GMAIL_HARD);
    expect(r.isBounce).toBe(true);
    expect(r.isHard).toBe(true);
    expect(r.status).toBe('5.1.1');
    expect(r.recipient).toBe('nobody@example.com');
    expect(r.confident).toBe(true);
  });

  it('parses Yahoo-style soft bounce (4.x.x)', () => {
    const r = parseDsnText('multipart/report; report-type=delivery-status', YAHOO_SOFT);
    expect(r.isBounce).toBe(true);
    expect(r.isHard).toBe(false);
    expect(r.status).toBe('4.2.2');
    expect(r.action).toBe('delayed');
  });

  it('infers hard from SMTP reply code when Status is missing', () => {
    // Force the body-only fallback path (no Status: line).
    const stripped = MICROSOFT_NO_STATUS.replace(/Status:\s*5\.1\.10\n?/i, '');
    const r = parseDsnText('text/plain', stripped);
    expect(r.isBounce).toBe(true);
    expect(r.isHard).toBe(true); // from the 550 in Diagnostic-Code
    expect(r.confident).toBe(true);
  });

  it('ignores normal mail', () => {
    const r = parseDsnText('text/plain', NOT_A_BOUNCE);
    expect(r.isBounce).toBe(false);
    expect(r.confident).toBe(false);
  });

  it('extracts diagnostic code for operator triage', () => {
    const r = parseDsnText('multipart/report; report-type=delivery-status', GMAIL_HARD);
    expect(r.diagnostic).toMatch(/account.*does not exist/);
  });
});

describe('parseArfText', () => {
  it('parses an abuse feedback report', () => {
    const r = parseArfText('multipart/report; report-type=feedback-report', ARF_COMPLAINT);
    expect(r.isComplaint).toBe(true);
    expect(r.feedbackType).toBe('abuse');
    expect(r.recipient).toBe('complainer@aol.com');
    expect(r.originalMessageId).toBe('<abc123@example.com>');
    expect(r.confident).toBe(true);
  });

  it('does not misidentify a regular message as a complaint', () => {
    const r = parseArfText('text/plain', NOT_A_BOUNCE);
    expect(r.isComplaint).toBe(false);
  });
});
