import crypto from 'node:crypto';
import { db } from './db.js';
import { regulatedModeIsActive } from './regulated-workloads.js';

export interface ArchiveCommunication {
  customerId: string;
  messageId: string;
  direction: 'outbound' | 'inbound';
  from: string;
  to: string;
  subject: string;
  html?: string | null;
  text?: string | null;
  headers?: Record<string, string>;
  attachments?: Array<{ filename: string; content_type: string; size: number; content_b64: string }>;
  occurredAt: string;
}

export interface ArchiveReceipt {
  provider: string;
  externalId: string;
  archivedAt: string;
  immutableUntil: string;
  contentSha256: string;
}

export interface RegulatedArchiveProvider {
  archive(record: ArchiveCommunication): Promise<ArchiveReceipt>;
}

export class RegulatedArchiveError extends Error {
  readonly code = 'regulated_archive_unavailable';
}

function canonical(record: ArchiveCommunication): string {
  return JSON.stringify({
    customer_id: record.customerId, message_id: record.messageId,
    direction: record.direction, from: record.from, to: record.to,
    subject: record.subject, html: record.html ?? null, text: record.text ?? null,
    headers: Object.fromEntries(Object.entries(record.headers ?? {}).sort(([a], [b]) => a.localeCompare(b))),
    attachments: record.attachments ?? [],
    occurred_at: record.occurredAt,
  });
}

class HttpArchiveProvider implements RegulatedArchiveProvider {
  async archive(record: ArchiveCommunication): Promise<ArchiveReceipt> {
    const url = process.env.SEC_ARCHIVE_URL;
    const token = process.env.SEC_ARCHIVE_TOKEN;
    if (!url || !token) throw new RegulatedArchiveError('SEC archive provider is not configured');
    const body = canonical(record);
    const checksum = crypto.createHash('sha256').update(body).digest('hex');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(process.env.SEC_ARCHIVE_TIMEOUT_MS ?? 10_000));
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': `mail-platform:${record.customerId}:${record.direction}:${record.messageId}`,
          'x-content-sha256': checksum,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw new RegulatedArchiveError(`Archive provider returned ${response.status}`);
      const receipt = await response.json() as Record<string, unknown>;
      if (typeof receipt.external_id !== 'string' || !receipt.external_id) {
        throw new RegulatedArchiveError('Archive provider did not return an external receipt id');
      }
      const archivedAt = typeof receipt.archived_at === 'string' ? receipt.archived_at : new Date().toISOString();
      const immutableUntil = typeof receipt.immutable_until === 'string'
        ? receipt.immutable_until
        : new Date(Date.now() + 6 * 365 * 86400_000).toISOString();
      return {
        provider: new URL(url).hostname,
        externalId: receipt.external_id,
        archivedAt,
        immutableUntil,
        contentSha256: checksum,
      };
    } catch (error) {
      if (error instanceof RegulatedArchiveError) throw error;
      throw new RegulatedArchiveError(error instanceof Error ? error.message : 'Archive provider failed');
    } finally {
      clearTimeout(timer);
    }
  }
}

let provider: RegulatedArchiveProvider = new HttpArchiveProvider();
export function setRegulatedArchiveProvider(value: RegulatedArchiveProvider): void {
  provider = value;
}
export function resetRegulatedArchiveProvider(): void {
  provider = new HttpArchiveProvider();
}

export async function archiveCommunicationIfRequired(record: ArchiveCommunication): Promise<ArchiveReceipt | null> {
  if (!(await regulatedModeIsActive(record.customerId, 'sec_finra'))) return null;
  const receipt = await provider.archive(record);
  await db.insertInto('regulated_archive_records').values({
    customer_id: record.customerId,
    message_id: record.messageId,
    direction: record.direction,
    provider: receipt.provider,
    external_id: receipt.externalId,
    content_sha256: receipt.contentSha256,
    archived_at: new Date(receipt.archivedAt),
    immutable_until: new Date(receipt.immutableUntil),
    reconciliation_status: 'verified',
    reconciled_at: new Date(),
  }).onConflict((oc) => oc.columns(['customer_id', 'message_id', 'direction']).doNothing()).execute();
  return receipt;
}
