// PCI-02 (compliance implementation plan): card-data detection and redaction.
//
// The platform is deliberately OUTSIDE the cardholder data environment: card
// entry happens at the payment provider, and no feature here is designed to
// accept a PAN. That design intent is not a control by itself — a customer can
// still paste a card number into a support ticket, an email body, or a webhook
// metadata field. This module is the detective control for those unintended
// channels, so accidental card data can be blocked, redacted, and alerted on
// instead of silently persisting in message bodies, tickets, and backups.
//
// FALSE POSITIVES ARE THE REAL RISK. A naive "13-19 digits" scan flags order
// ids, epoch-millisecond timestamps, and phone numbers, and would reject
// legitimate mail. Detection therefore requires ALL THREE of:
//   1. a digit run of a card-plausible length, not embedded in a longer run,
//   2. a valid Luhn check digit, and
//   3. a recognized major-brand IIN prefix at a length that brand actually
//      issues.
// A 13-digit epoch timestamp (1784992010389) fails (3) because no brand issues
// a "1" prefix; a 20-digit reference number fails (1) because of the digit
// boundary guards.
//
// FINDINGS NEVER CARRY THE VALUE. A CardFinding records the brand and the field
// name only. Evidence about card data must not itself become a place card data
// is stored (see the evidence-register rules in the compliance plan), so
// nothing here returns, logs, or persists the matched digits.

/** A detected occurrence. Deliberately carries no digits from the match. */
export interface CardFinding {
  kind: 'pan' | 'cvv';
  /** Card brand for a PAN match; undefined for a keyword-anchored CVV match. */
  brand?: string;
  /** The field the match was found in. Never the matched value. */
  field: string;
}

/** Placeholder substituted for a detected PAN. Contains no digits. */
export const CARD_REDACTION = '[redacted-card]';
/** Placeholder substituted for a detected security code. */
export const CVV_REDACTION = '[redacted-cvv]';

// Candidate digit runs: 13-19 digits, optionally single-space or hyphen
// separated, not adjacent to another digit on either side. The boundary
// assertions are what stop a long numeric identifier from yielding a
// card-length substring.
const CANDIDATE_RE = /(?<![0-9])(?:[0-9][ -]?){12,18}[0-9](?![0-9])/g;

// Security codes are only meaningful when labelled. A bare 3-4 digit number is
// far too common to treat as sensitive authentication data.
const CVV_RE = /\b(cvv2?|cvc2?|cid|csc|security\s*code|card\s*code)\b\s*[:=#-]?\s*([0-9]{3,4})(?![0-9])/gi;

interface BrandRule {
  brand: string;
  /** Lengths this brand actually issues. */
  lengths: number[];
  test: (digits: string) => boolean;
}

const BRANDS: BrandRule[] = [
  { brand: 'visa', lengths: [13, 16, 19], test: (d) => d.startsWith('4') },
  {
    brand: 'mastercard',
    lengths: [16],
    test: (d) => {
      if (/^5[1-5]/.test(d)) return true;
      // 2-series range introduced in 2017: 222100-272099.
      const p = Number(d.slice(0, 6));
      return p >= 222100 && p <= 272099;
    },
  },
  { brand: 'amex', lengths: [15], test: (d) => /^3[47]/.test(d) },
  { brand: 'discover', lengths: [16, 17, 18, 19], test: (d) => /^(6011|64[4-9]|65)/.test(d) },
  { brand: 'jcb', lengths: [16, 17, 18, 19], test: (d) => /^35(2[89]|[3-8][0-9])/.test(d) },
  { brand: 'diners', lengths: [14, 15, 16, 17, 18, 19], test: (d) => /^3(0[0-5]|[68])/.test(d) },
  { brand: 'unionpay', lengths: [16, 17, 18, 19], test: (d) => /^62/.test(d) },
];

/** Standard Luhn mod-10 check. Input must be digits only. */
export function isLuhnValid(digits: string): boolean {
  if (digits.length < 12) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Return the card brand for a digits-only string, or null when the value is
 * not a plausible PAN. Applies the brand-prefix, issued-length, and Luhn tests
 * together — any one of them alone produces unacceptable false positives.
 */
export function detectCardBrand(digits: string): string | null {
  if (!/^[0-9]+$/.test(digits)) return null;
  for (const rule of BRANDS) {
    if (!rule.lengths.includes(digits.length)) continue;
    if (!rule.test(digits)) continue;
    if (!isLuhnValid(digits)) continue;
    return rule.brand;
  }
  return null;
}

/** True when the string contains something that passes every PAN test. */
export function containsPan(input: string): boolean {
  CANDIDATE_RE.lastIndex = 0;
  for (const m of input.matchAll(CANDIDATE_RE)) {
    if (detectCardBrand(m[0].replace(/[ -]/g, ''))) return true;
  }
  return false;
}

/**
 * Replace every detected PAN and labelled security code with a digit-free
 * placeholder. Returns the redacted text plus value-free findings.
 *
 * `field` names the source for the findings only; it does not affect matching.
 */
export function redactCardData(input: string, field = 'text'): { text: string; findings: CardFinding[] } {
  const findings: CardFinding[] = [];
  if (!input) return { text: input, findings };

  let text = input.replace(CANDIDATE_RE, (match) => {
    const brand = detectCardBrand(match.replace(/[ -]/g, ''));
    if (!brand) return match; // not a card — leave the original text intact
    findings.push({ kind: 'pan', brand, field });
    return CARD_REDACTION;
  });

  text = text.replace(CVV_RE, (_match, label: string) => {
    findings.push({ kind: 'cvv', field });
    return `${label}: ${CVV_REDACTION}`;
  });

  return { text, findings };
}

/** True when the input holds a PAN or a labelled security code. */
export function containsCardData(input: string | null | undefined): boolean {
  if (!input) return false;
  return redactCardData(input).findings.length > 0;
}

/**
 * Scan a set of named fields and return every finding across them. Used by the
 * send and support ingress checks to report WHICH field carried card data
 * without ever echoing the value back to the caller or into a log.
 */
export function scanFields(fields: Record<string, string | null | undefined>): CardFinding[] {
  const findings: CardFinding[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    findings.push(...redactCardData(value, field).findings);
  }
  return findings;
}

/** Compact, value-free summary for audit metadata and alerts. */
export function summarizeFindings(findings: CardFinding[]): { fields: string[]; brands: string[]; pan: number; cvv: number } {
  return {
    fields: [...new Set(findings.map((f) => f.field))].sort(),
    brands: [...new Set(findings.map((f) => f.brand).filter((b): b is string => !!b))].sort(),
    pan: findings.filter((f) => f.kind === 'pan').length,
    cvv: findings.filter((f) => f.kind === 'cvv').length,
  };
}
