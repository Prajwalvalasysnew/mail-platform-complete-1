// DMARC aggregate-report parsing — pure unit tests (no DB).
import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { parseDmarcAggregateReport, DmarcReportError } from '@platform/shared';

// A realistic RFC 7489 aggregate report: one aligned source (google) and one
// spoofing source (both auth results fail).
const SAMPLE = `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>18004112345678</report_id>
    <date_range><begin>1719360000</begin><end>1719446400</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>acme.com</domain>
    <adkim>r</adkim><aspf>r</aspf>
    <p>quarantine</p><sp>quarantine</sp><pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>209.85.220.41</source_ip>
      <count>1200</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>acme.com</header_from></identifiers>
    <auth_results>
      <dkim><domain>acme.com</domain><result>pass</result></dkim>
      <spf><domain>acme.com</domain><result>pass</result></spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>45.83.12.9</source_ip>
      <count>340</count>
      <policy_evaluated><disposition>quarantine</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated>
    </row>
    <identifiers><header_from>acme.com</header_from></identifiers>
    <auth_results>
      <dkim><domain>evil.example</domain><result>fail</result></dkim>
      <spf><domain>evil.example</domain><result>fail</result></spf>
    </auth_results>
  </record>
</feedback>`;

describe('parseDmarcAggregateReport', () => {
  it('parses raw XML with policy, records, and alignment totals', () => {
    const r = parseDmarcAggregateReport(Buffer.from(SAMPLE));
    expect(r.org_name).toBe('google.com');
    expect(r.report_id).toBe('18004112345678');
    expect(r.domain).toBe('acme.com');
    expect(r.policy.p).toBe('quarantine');
    expect(r.policy.pct).toBe(100);
    expect(r.records).toHaveLength(2);
    expect(r.total_messages).toBe(1540);
    expect(r.aligned_messages).toBe(1200); // only the google source passed

    const spoof = r.records.find((x) => x.source_ip === '45.83.12.9')!;
    expect(spoof.dmarc_pass).toBe(false);
    expect(spoof.disposition).toBe('quarantine');
    expect(spoof.dkim_domain).toBe('evil.example');
  });

  it('parses gzip-compressed reports (the Gmail format)', () => {
    const gz = zlib.gzipSync(Buffer.from(SAMPLE));
    const r = parseDmarcAggregateReport(gz);
    expect(r.domain).toBe('acme.com');
    expect(r.total_messages).toBe(1540);
  });

  it('parses zip-compressed reports', () => {
    // Build a minimal single-entry zip (deflate) around the XML.
    const raw = Buffer.from(SAMPLE);
    const deflated = zlib.deflateRawSync(raw);
    const name = Buffer.from('report.xml');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header sig
    header.writeUInt16LE(20, 4); // version
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(8, 8); // method: deflate
    header.writeUInt32LE(0, 14); // crc (ignored by our extractor)
    header.writeUInt32LE(deflated.length, 18); // compressed size
    header.writeUInt32LE(raw.length, 22); // uncompressed size
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    const zip = Buffer.concat([header, name, deflated]);
    const r = parseDmarcAggregateReport(zip);
    expect(r.domain).toBe('acme.com');
    expect(r.records).toHaveLength(2);
  });

  it('rejects reports with a DOCTYPE/ENTITY declaration (XXE / billion-laughs guard)', () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE feedback [<!ENTITY x "y">]><feedback></feedback>`;
    expect(() => parseDmarcAggregateReport(Buffer.from(evil))).toThrow(DmarcReportError);
    try {
      parseDmarcAggregateReport(Buffer.from(evil));
    } catch (e: any) {
      expect(e.code).toBe('unsafe_xml');
    }
  });

  it('rejects a report missing a date range', () => {
    const bad = `<feedback><report_metadata><org_name>x</org_name><report_id>1</report_id></report_metadata><policy_published><domain>a.com</domain></policy_published></feedback>`;
    expect(() => parseDmarcAggregateReport(Buffer.from(bad))).toThrow(/date range/i);
  });

  it('decodes XML entities in values', () => {
    const withEntities = SAMPLE.replace('google.com', 'a&amp;b.com');
    const r = parseDmarcAggregateReport(Buffer.from(withEntities));
    expect(r.org_name).toBe('a&b.com');
  });
});
