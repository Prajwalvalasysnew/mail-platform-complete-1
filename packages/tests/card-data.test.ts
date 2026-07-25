// PCI-02: card-data detection must catch real PANs in unintended channels
// WITHOUT flagging the ordinary numeric data that flows through a mail
// platform (order ids, epoch timestamps, phone numbers, tracking references).
// A detector that cries wolf gets switched off, so the false-positive cases
// below are as load-bearing as the true-positive ones.
//
// Every card number here is a well-known publicly published TEST value from
// payment-provider documentation. They are Luhn-valid but not issued to
// anyone, so this file contains no real cardholder data.

import { describe, it, expect } from 'vitest';
import {
  isLuhnValid,
  detectCardBrand,
  containsCardData,
  containsPan,
  redactCardData,
  scanFields,
  summarizeFindings,
  CARD_REDACTION,
} from '@platform/shared';

// Publicly documented provider test numbers.
const VISA = '4242424242424242';
const VISA_13 = '4222222222222';
const MASTERCARD = '5555555555554444';
const MC_2SERIES = '2223003122003222';
const AMEX = '378282246310005';
const DISCOVER = '6011111111111117';
const JCB = '3566002020360505';
const DINERS = '36227206271667';

describe('isLuhnValid', () => {
  it('accepts valid check digits and rejects altered ones', () => {
    expect(isLuhnValid(VISA)).toBe(true);
    expect(isLuhnValid(AMEX)).toBe(true);
    expect(isLuhnValid('4242424242424243')).toBe(false);
  });

  it('rejects non-digit input', () => {
    expect(isLuhnValid('4242-4242-4242-4242')).toBe(false);
  });
});

describe('detectCardBrand', () => {
  it('identifies each major brand at an issued length', () => {
    expect(detectCardBrand(VISA)).toBe('visa');
    expect(detectCardBrand(VISA_13)).toBe('visa');
    expect(detectCardBrand(MASTERCARD)).toBe('mastercard');
    expect(detectCardBrand(MC_2SERIES)).toBe('mastercard');
    expect(detectCardBrand(AMEX)).toBe('amex');
    expect(detectCardBrand(DISCOVER)).toBe('discover');
    expect(detectCardBrand(JCB)).toBe('jcb');
    expect(detectCardBrand(DINERS)).toBe('diners');
  });

  it('rejects a Luhn-valid number at a length its brand does not issue', () => {
    // 4242424242424242 is a valid 16-digit Visa; drop to 14 digits and it is
    // no longer a length Visa issues, so brand+length must reject it.
    expect(detectCardBrand('42424242424242')).toBe(null);
  });

  it('rejects a Luhn-valid number with no brand prefix', () => {
    // 13-digit, passes Luhn, but no brand issues a "1" prefix.
    const noBrand = '1784992010389';
    expect(detectCardBrand(noBrand)).toBe(null);
  });
});

describe('card detection false positives', () => {
  it('does not flag a 13-digit epoch-millisecond timestamp', () => {
    expect(containsCardData(`sent at ${Date.now()}`)).toBe(false);
  });

  it('does not flag a long numeric reference embedded in a longer run', () => {
    // 20 digits: the digit-boundary guards must stop a card-length substring
    // from matching inside it.
    expect(containsCardData('order 12345678901234567890')).toBe(false);
  });

  it('does not flag phone numbers or short ids', () => {
    expect(containsCardData('call +1 415 555 0100')).toBe(false);
    expect(containsCardData('invoice 00012345')).toBe(false);
  });

  it('does not flag a UUID', () => {
    expect(containsCardData('id 3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(false);
  });
});

describe('redactCardData', () => {
  it('redacts a bare PAN and reports the brand without the digits', () => {
    const out = redactCardData(`my card is ${VISA} ok`, 'text');
    expect(out.text).toBe(`my card is ${CARD_REDACTION} ok`);
    expect(out.text).not.toContain('4242');
    expect(out.findings).toEqual([{ kind: 'pan', brand: 'visa', field: 'text' }]);
  });

  it('redacts space- and hyphen-separated PANs', () => {
    expect(redactCardData('4242 4242 4242 4242').text).toBe(CARD_REDACTION);
    expect(redactCardData('4242-4242-4242-4242').text).toBe(CARD_REDACTION);
  });

  it('redacts multiple PANs in one body', () => {
    const out = redactCardData(`${VISA} and ${AMEX}`);
    expect(out.findings).toHaveLength(2);
    expect(out.text).not.toMatch(/[0-9]{13,}/);
  });

  it('redacts a labelled security code but not a bare 3-digit number', () => {
    const labelled = redactCardData('cvv: 123');
    expect(labelled.findings.some((f) => f.kind === 'cvv')).toBe(true);
    expect(labelled.text).not.toContain('123');

    expect(containsCardData('there are 123 messages queued')).toBe(false);
  });

  it('leaves non-card text byte-identical', () => {
    const input = 'Your order 00012345 ships on 2026-07-25. Total 42.00 USD.';
    const out = redactCardData(input);
    expect(out.text).toBe(input);
    expect(out.findings).toEqual([]);
  });

  it('handles empty and null-ish input', () => {
    expect(redactCardData('').text).toBe('');
    expect(containsCardData(null)).toBe(false);
    expect(containsCardData(undefined)).toBe(false);
  });
});

describe('containsPan', () => {
  it('is true only for PANs, not labelled CVVs', () => {
    expect(containsPan(VISA)).toBe(true);
    expect(containsPan('cvv: 123')).toBe(false);
  });
});

describe('scanFields and summarizeFindings', () => {
  it('reports which field carried card data, never the value', () => {
    const findings = scanFields({ subject: 'hello', html: `pay with ${MASTERCARD}`, text: null });
    expect(findings).toEqual([{ kind: 'pan', brand: 'mastercard', field: 'html' }]);

    const summary = summarizeFindings(findings);
    expect(summary).toEqual({ fields: ['html'], brands: ['mastercard'], pan: 1, cvv: 0 });
    // The summary is what goes into audit metadata and alerts — it must not
    // be able to carry digits.
    expect(JSON.stringify(summary)).not.toMatch(/[0-9]{4,}/);
  });
});
