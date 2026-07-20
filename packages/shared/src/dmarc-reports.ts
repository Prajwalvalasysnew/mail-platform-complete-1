// DMARC aggregate-report ingestion + reporting.
//
// Parses RFC 7489 aggregate reports (the XML mail providers send to a domain's
// rua= address), stores per-source results, and answers "who is sending as
// your domain, and is it authenticated?".
//
// The XML is parsed with a small, targeted extractor rather than a general XML
// library: the aggregate-report schema is flat and machine-generated, and a
// scoped extractor with a hard DOCTYPE/ENTITY reject has no XXE or
// entity-expansion (billion-laughs) attack surface — important because the
// input is attacker-influenceable (anyone can send a report to the address).

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { sql } from 'kysely';
import { db } from './db.js';
import { withTenant, type TenantExecutor } from './tenant-context.js';

export class DmarcReportError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = 'DmarcReportError';
  }
}

const MAX_DECOMPRESSED_BYTES = Number(process.env.DMARC_MAX_REPORT_BYTES ?? 25 * 1024 * 1024);
const MAX_RECORDS = Number(process.env.DMARC_MAX_RECORDS_PER_REPORT ?? 100_000);

// ---------------------------------------------------------------------------
// Decompression (raw XML / gzip / zip)
// ---------------------------------------------------------------------------

function decompress(input: Buffer): string {
  if (input.length === 0) throw new DmarcReportError('empty_report', 'Empty report');
  // gzip magic
  if (input[0] === 0x1f && input[1] === 0x8b) {
    const out = zlib.gunzipSync(input, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    return out.toString('utf8');
  }
  // zip magic (PK\x03\x04) — single-entry local file header, deflate or stored.
  if (input[0] === 0x50 && input[1] === 0x4b && input[2] === 0x03 && input[3] === 0x04) {
    return unzipFirstEntry(input);
  }
  // raw XML (optionally with BOM)
  const text = input.toString('utf8').replace(/^﻿/, '');
  if (text.length > MAX_DECOMPRESSED_BYTES) throw new DmarcReportError('report_too_large', 'Report exceeds size limit');
  return text;
}

function unzipFirstEntry(buf: Buffer): string {
  // Local file header: sig(4) ver(2) flags(2) method(2) time(2) date(2)
  // crc(4) compSize(4) uncompSize(4) nameLen(2) extraLen(2)
  const method = buf.readUInt16LE(8);
  const flags = buf.readUInt16LE(6);
  let compSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const dataStart = 30 + nameLen + extraLen;

  // Streaming zips set bit 3 and put sizes in a trailing data descriptor;
  // compSize is 0 in the header. Fall back to the next PK signature.
  if (compSize === 0 && (flags & 0x08) !== 0) {
    const nextPk = buf.indexOf(Buffer.from([0x50, 0x4b]), dataStart);
    compSize = (nextPk === -1 ? buf.length : nextPk) - dataStart;
  }
  const data = buf.subarray(dataStart, dataStart + compSize);
  const out =
    method === 0
      ? data
      : method === 8
        ? zlib.inflateRawSync(data, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
        : (() => { throw new DmarcReportError('unsupported_zip', `Unsupported zip method ${method}`); })();
  return out.toString('utf8');
}

// ---------------------------------------------------------------------------
// Safe targeted XML extraction
// ---------------------------------------------------------------------------

function assertNoXxe(xml: string): void {
  // Reject DOCTYPE/ENTITY and external-reference keywords outright — the
  // aggregate-report schema never uses them, and they are the entire XXE /
  // entity-expansion attack surface.
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml) || /\bSYSTEM\b|\bPUBLIC\b/.test(xml.slice(0, 4096))) {
    throw new DmarcReportError('unsafe_xml', 'Report contains a DOCTYPE/ENTITY declaration');
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

/** Inner text of the first <tag>...</tag> in `xml` (namespace-tolerant), or undefined. */
function tag(xml: string, name: string): string | undefined {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'i');
  const m = re.exec(xml);
  return m ? decodeEntities(m[1]!.trim()) : undefined;
}

/** Inner contents of every <tag>...</tag> block. */
function blocks(xml: string, name: string): string[] {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1]!);
    if (out.length > MAX_RECORDS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export interface ParsedDmarcRecord {
  source_ip: string;
  message_count: number;
  disposition: string | null;
  dkim_result: string | null; // policy_evaluated
  spf_result: string | null;
  header_from: string | null;
  spf_domain: string | null;
  dkim_domain: string | null;
  dmarc_pass: boolean;
}

export interface ParsedDmarcReport {
  org_name: string;
  report_id: string;
  domain: string;
  date_range_begin: Date;
  date_range_end: Date;
  policy: { p: string | null; sp: string | null; pct: number | null; adkim: string | null; aspf: string | null };
  records: ParsedDmarcRecord[];
  total_messages: number;
  aligned_messages: number;
}

export function parseDmarcAggregateReport(input: Buffer): ParsedDmarcReport {
  const xml = decompress(input);
  assertNoXxe(xml);

  const feedback = tag(xml, 'feedback') !== undefined ? xml : xml; // whole doc
  const meta = blocks(feedback, 'report_metadata')[0] ?? '';
  const published = blocks(feedback, 'policy_published')[0] ?? '';

  const org_name = tag(meta, 'org_name') ?? 'unknown';
  const report_id = tag(meta, 'report_id') ?? crypto.randomUUID();
  const dateRange = blocks(meta, 'date_range')[0] ?? '';
  const begin = Number(tag(dateRange, 'begin') ?? 0);
  const end = Number(tag(dateRange, 'end') ?? 0);
  const domain = (tag(published, 'domain') ?? tag(feedback, 'domain') ?? 'unknown').toLowerCase();
  const pctRaw = tag(published, 'pct');

  const records: ParsedDmarcRecord[] = [];
  let total = 0;
  let aligned = 0;
  for (const rec of blocks(feedback, 'record')) {
    const row = blocks(rec, 'row')[0] ?? '';
    const evaluated = blocks(row, 'policy_evaluated')[0] ?? '';
    const identifiers = blocks(rec, 'identifiers')[0] ?? '';
    const authResults = blocks(rec, 'auth_results')[0] ?? '';
    const count = Math.max(0, Math.floor(Number(tag(row, 'count') ?? 0)));
    const dkimEval = (tag(evaluated, 'dkim') ?? '').toLowerCase() || null;
    const spfEval = (tag(evaluated, 'spf') ?? '').toLowerCase() || null;
    const pass = dkimEval === 'pass' || spfEval === 'pass';

    records.push({
      source_ip: (tag(row, 'source_ip') ?? '').slice(0, 45),
      message_count: count,
      disposition: (tag(evaluated, 'disposition') ?? '').toLowerCase() || null,
      dkim_result: dkimEval,
      spf_result: spfEval,
      header_from: (tag(identifiers, 'header_from') ?? '').toLowerCase() || null,
      dkim_domain: (tag(blocks(authResults, 'dkim')[0] ?? '', 'domain') ?? '').toLowerCase() || null,
      spf_domain: (tag(blocks(authResults, 'spf')[0] ?? '', 'domain') ?? '').toLowerCase() || null,
      dmarc_pass: pass,
    });
    total += count;
    if (pass) aligned += count;
    if (records.length >= MAX_RECORDS) break;
  }

  if (!begin || !end) throw new DmarcReportError('invalid_report', 'Report is missing a date range');

  return {
    org_name,
    report_id,
    domain,
    date_range_begin: new Date(begin * 1000),
    date_range_end: new Date(end * 1000),
    policy: {
      p: (tag(published, 'p') ?? '').toLowerCase() || null,
      sp: (tag(published, 'sp') ?? '').toLowerCase() || null,
      pct: pctRaw != null && pctRaw !== '' ? Number(pctRaw) : null,
      adkim: (tag(published, 'adkim') ?? '').toLowerCase() || null,
      aspf: (tag(published, 'aspf') ?? '').toLowerCase() || null,
    },
    records,
    total_messages: total,
    aligned_messages: aligned,
  };
}

// ---------------------------------------------------------------------------
// Reporting token (rua= address resolution)
// ---------------------------------------------------------------------------

export function dmarcReportDomain(): string {
  return process.env.DMARC_REPORT_DOMAIN ?? `dmarc.${process.env.PLATFORM_DOMAIN ?? 'mail.example.com'}`;
}

/** Get-or-create a customer's DMARC reporting token, returning the full rua address. */
export async function ensureDmarcReportToken(customerId: string): Promise<{ token: string; rua_address: string }> {
  const existing = await db
    .selectFrom('customers')
    .select('dmarc_report_token')
    .where('id', '=', customerId)
    .executeTakeFirst();
  let token = existing?.dmarc_report_token ?? null;
  if (!token) {
    token = `dmarc_${crypto.randomBytes(9).toString('base64url')}`;
    await db.updateTable('customers').set({ dmarc_report_token: token }).where('id', '=', customerId).execute();
  }
  return { token, rua_address: `${token}@${dmarcReportDomain()}` };
}

/** Resolve a reporting token (from the rua local-part) to a customer id. */
export async function resolveDmarcToken(token: string): Promise<string | null> {
  const row = await db
    .selectFrom('customers')
    .select('id')
    .where('dmarc_report_token', '=', token)
    .executeTakeFirst();
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export interface IngestResult {
  ingested: boolean;
  duplicate?: boolean;
  report_id?: string;
  org_name: string;
  domain: string;
  total_messages: number;
  aligned_messages: number;
}

/**
 * Parse and store a report for a customer. Idempotent: a duplicate
 * (customer, org, report_id) is a no-op. `executor` lets API callers pass
 * their tenant transaction; system/inbound callers use withTenant.
 */
export async function ingestDmarcReport(
  customerId: string,
  raw: Buffer,
  executor?: TenantExecutor
): Promise<IngestResult> {
  const parsed = parseDmarcAggregateReport(raw);
  const run = <T>(fn: (trx: TenantExecutor) => Promise<T>): Promise<T> =>
    executor ? fn(executor) : withTenant(customerId, fn);

  return run(async (trx) => {
    const report = await trx
      .insertInto('dmarc_reports')
      .values({
        customer_id: customerId,
        domain: parsed.domain,
        org_name: parsed.org_name,
        report_id: parsed.report_id,
        date_range_begin: parsed.date_range_begin,
        date_range_end: parsed.date_range_end,
        policy_p: parsed.policy.p,
        policy_sp: parsed.policy.sp,
        policy_pct: parsed.policy.pct,
        policy_adkim: parsed.policy.adkim,
        policy_aspf: parsed.policy.aspf,
        total_messages: parsed.total_messages,
        aligned_messages: parsed.aligned_messages,
      } as any)
      .onConflict((oc) => oc.columns(['customer_id', 'org_name', 'report_id']).doNothing())
      .returning('id')
      .executeTakeFirst();

    if (!report) {
      return {
        ingested: false,
        duplicate: true,
        org_name: parsed.org_name,
        domain: parsed.domain,
        total_messages: parsed.total_messages,
        aligned_messages: parsed.aligned_messages,
      };
    }

    if (parsed.records.length > 0) {
      // Chunked insert to stay within parameter limits on huge reports.
      const CHUNK = 500;
      for (let i = 0; i < parsed.records.length; i += CHUNK) {
        await trx
          .insertInto('dmarc_report_records')
          .values(
            parsed.records.slice(i, i + CHUNK).map((r) => ({
              report_id: report.id,
              customer_id: customerId,
              domain: parsed.domain,
              source_ip: r.source_ip,
              message_count: r.message_count,
              disposition: r.disposition,
              dkim_result: r.dkim_result,
              spf_result: r.spf_result,
              header_from: r.header_from,
              spf_domain: r.spf_domain,
              dkim_domain: r.dkim_domain,
              dmarc_pass: r.dmarc_pass,
            })) as any
          )
          .execute();
      }
    }

    return {
      ingested: true,
      report_id: report.id,
      org_name: parsed.org_name,
      domain: parsed.domain,
      total_messages: parsed.total_messages,
      aligned_messages: parsed.aligned_messages,
    };
  });
}

// ---------------------------------------------------------------------------
// Reporting queries
// ---------------------------------------------------------------------------

export interface DmarcSummary {
  window_days: number;
  reports: number;
  total_messages: number;
  aligned_messages: number;
  pass_rate: number; // 0..1
  by_disposition: Record<string, number>;
  latest_policy: { domain: string; p: string | null; pct: number | null } | null;
}

export async function dmarcSummary(
  customerId: string,
  opts: { domain?: string; days?: number } = {},
  executor?: TenantExecutor
): Promise<DmarcSummary> {
  const days = Math.max(1, Math.min(opts.days ?? 30, 365));
  const run = <T>(fn: (trx: TenantExecutor) => Promise<T>): Promise<T> =>
    executor ? fn(executor) : withTenant(customerId, fn);

  return run(async (trx) => {
    let repQ = trx
      .selectFrom('dmarc_reports')
      .where('customer_id', '=', customerId)
      .where(sql<boolean>`date_range_begin >= NOW() - (${days} * INTERVAL '1 day')`);
    if (opts.domain) repQ = repQ.where('domain', '=', opts.domain.toLowerCase());

    const agg = await repQ
      .select([
        sql<number>`COUNT(*)`.as('reports'),
        sql<number>`COALESCE(SUM(total_messages), 0)`.as('total'),
        sql<number>`COALESCE(SUM(aligned_messages), 0)`.as('aligned'),
      ])
      .executeTakeFirst();

    let recQ = trx
      .selectFrom('dmarc_report_records')
      .where('customer_id', '=', customerId)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom('dmarc_reports')
            .select('id')
            .whereRef('dmarc_reports.id', '=', 'dmarc_report_records.report_id')
            .where(sql<boolean>`dmarc_reports.date_range_begin >= NOW() - (${days} * INTERVAL '1 day')`)
        )
      );
    if (opts.domain) recQ = recQ.where('domain', '=', opts.domain.toLowerCase());
    const dispRows = await recQ
      .select(['disposition', sql<number>`COALESCE(SUM(message_count), 0)`.as('n')])
      .groupBy('disposition')
      .execute();

    const latest = await trx
      .selectFrom('dmarc_reports')
      .select(['domain', 'policy_p', 'policy_pct'])
      .where('customer_id', '=', customerId)
      .$if(!!opts.domain, (q) => q.where('domain', '=', opts.domain!.toLowerCase()))
      .orderBy('date_range_begin', 'desc')
      .limit(1)
      .executeTakeFirst();

    const total = Number(agg?.total ?? 0);
    const aligned = Number(agg?.aligned ?? 0);
    const by_disposition: Record<string, number> = {};
    for (const r of dispRows) by_disposition[r.disposition ?? 'none'] = Number(r.n);

    return {
      window_days: days,
      reports: Number(agg?.reports ?? 0),
      total_messages: total,
      aligned_messages: aligned,
      pass_rate: total > 0 ? aligned / total : 1,
      by_disposition,
      latest_policy: latest ? { domain: latest.domain, p: latest.policy_p, pct: latest.policy_pct } : null,
    };
  });
}

export interface DmarcSource {
  source_ip: string;
  header_from: string | null;
  messages: number;
  aligned: number;
  pass_rate: number;
  likely_spoof: boolean;
}

/** "Who is sending as your domain" — per-source-IP roll-up, worst first. */
export async function dmarcSources(
  customerId: string,
  opts: { domain?: string; days?: number; limit?: number } = {},
  executor?: TenantExecutor
): Promise<DmarcSource[]> {
  const days = Math.max(1, Math.min(opts.days ?? 30, 365));
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const run = <T>(fn: (trx: TenantExecutor) => Promise<T>): Promise<T> =>
    executor ? fn(executor) : withTenant(customerId, fn);

  return run(async (trx) => {
    let q = trx
      .selectFrom('dmarc_report_records')
      .where('customer_id', '=', customerId)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom('dmarc_reports')
            .select('id')
            .whereRef('dmarc_reports.id', '=', 'dmarc_report_records.report_id')
            .where(sql<boolean>`dmarc_reports.date_range_begin >= NOW() - (${days} * INTERVAL '1 day')`)
        )
      );
    if (opts.domain) q = q.where('domain', '=', opts.domain.toLowerCase());

    const rows = await q
      .select([
        'source_ip',
        sql<string>`(ARRAY_AGG(header_from ORDER BY message_count DESC))[1]`.as('header_from'),
        sql<number>`SUM(message_count)`.as('messages'),
        sql<number>`SUM(message_count) FILTER (WHERE dmarc_pass)`.as('aligned'),
      ])
      .groupBy('source_ip')
      .orderBy(sql`SUM(message_count) FILTER (WHERE dmarc_pass) ASC`)
      .orderBy(sql`SUM(message_count) DESC`)
      .limit(limit)
      .execute();

    return rows.map((r) => {
      const messages = Number(r.messages);
      const aligned = Number(r.aligned ?? 0);
      const rate = messages > 0 ? aligned / messages : 0;
      return {
        source_ip: r.source_ip,
        header_from: r.header_from ?? null,
        messages,
        aligned,
        pass_rate: rate,
        // A source with real volume that never authenticates is either a
        // forgotten legitimate sender or an active spoofer — the row the
        // customer must investigate before moving to p=reject.
        likely_spoof: messages >= 5 && rate === 0,
      };
    });
  });
}
