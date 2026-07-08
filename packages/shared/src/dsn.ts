// DSN (RFC 3464) + ARF (RFC 5965) parsing — extracted into a pure, testable
// module so it can be unit-tested against a corpus of real-world bounces. The
// inbound Haraka plugin delegates to the same logic shape.
//
// Real-world DSNs are wildly inconsistent: some put Status in the
// message/delivery-status part, some only in human-readable text; recipients
// appear as Final-Recipient or Original-Recipient with various address-type
// prefixes. We parse defensively and expose a parse-success signal so the
// inbound MTA can track parse-failure rate as a metric.

export interface DsnResult {
  isBounce: boolean;
  status: string | null;       // e.g. "5.1.1"
  diagnostic: string | null;
  recipient: string | null;
  action: string | null;       // failed | delayed | delivered | relayed | expanded
  isHard: boolean;             // 5.x.x permanent
  confident: boolean;          // did we extract a structured status?
}

export interface ArfResult {
  isComplaint: boolean;
  feedbackType: string | null; // abuse | fraud | virus | other
  recipient: string | null;
  originalMessageId: string | null;
  confident: boolean;
}

function firstMatch(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m ? m[1]!.trim() : null;
}

/** Parse a DSN from its full text (headers + all parts concatenated). */
export function parseDsnText(contentType: string, blob: string): DsnResult {
  const result: DsnResult = {
    isBounce: false, status: null, diagnostic: null, recipient: null,
    action: null, isHard: false, confident: false,
  };

  const looksLikeDsn =
    /delivery-status/i.test(contentType) ||
    /report-type=["']?delivery-status/i.test(contentType) ||
    /Diagnostic-Code:/i.test(blob) ||
    /Final-Recipient:/i.test(blob);
  if (!looksLikeDsn) return result;
  result.isBounce = true;

  // Structured fields (preferred)
  const status = firstMatch(blob, /^Status:\s*([0-9]+\.[0-9]+\.[0-9]+)/im);
  if (status) {
    result.status = status;
    result.isHard = status.startsWith('5');
    result.confident = true;
  }

  result.action = firstMatch(blob, /^Action:\s*([a-z]+)/im);
  result.diagnostic =
    firstMatch(blob, /^Diagnostic-Code:\s*(.+?)(?:\r?\n(?!\s)|$)/ims) ??
    firstMatch(blob, /Diagnostic-Code:\s*(.+)/i);

  // Recipient: Final-Recipient / Original-Recipient "rfc822; addr"
  const rcpt =
    firstMatch(blob, /^(?:Final|Original)-Recipient:\s*[^;]+;\s*(.+?)\s*$/im) ??
    firstMatch(blob, /<([^>]+@[^>]+)>/);
  result.recipient = rcpt;

  // Fallback hard/soft inference from SMTP reply code in the diagnostic when no Status.
  if (!result.status && result.diagnostic) {
    const code = result.diagnostic.match(/\b([45])\d\d\b/);
    if (code) {
      result.isHard = code[1] === '5';
      result.confident = true;
    }
  }
  // Action: failed strongly implies a real bounce
  if (result.action === 'failed' && !result.status) result.isHard = true;

  return result;
}

/** Parse an ARF feedback report from its full text. */
export function parseArfText(contentType: string, blob: string): ArfResult {
  const result: ArfResult = {
    isComplaint: false, feedbackType: null, recipient: null,
    originalMessageId: null, confident: false,
  };
  const looksLikeArf =
    /feedback-report/i.test(contentType) || /Feedback-Type:/i.test(blob);
  if (!looksLikeArf) return result;
  result.isComplaint = true;

  result.feedbackType = firstMatch(blob, /^Feedback-Type:\s*(\S+)/im);
  result.recipient =
    firstMatch(blob, /^Original-Rcpt-To:\s*(.+?)\s*$/im) ??
    firstMatch(blob, /^Removal-Recipient:\s*(.+?)\s*$/im);
  result.originalMessageId = firstMatch(blob, /^Message-ID:\s*(<[^>]+>)/im);
  result.confident = !!result.feedbackType;
  return result;
}
