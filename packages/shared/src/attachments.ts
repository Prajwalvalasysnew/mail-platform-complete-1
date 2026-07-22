// Attachment validation for /v1/send (invoices, payroll slips, lab reports,
// license keys — the ICP corpus's document-heavy senders).
//
// Policy:
//   - max 10 attachments per message
//   - per-attachment decoded cap (ATTACHMENT_MAX_BYTES, default 5 MB) and a
//     per-message total (ATTACHMENT_MAX_TOTAL_BYTES, default 7 MB — the API
//     body limit is 10 MB and base64 inflates ~33%)
//   - executable/script extensions are refused outright (the Gmail/Outlook
//     block list); everything else is allowed and delivered as-is
//   - filenames are sanitized to a safe charset (no path separators, no
//     control chars) so downstream MIME headers can never be smuggled

import net from 'node:net';
import { attachmentScans } from './metrics.js';

export interface AttachmentInput {
  filename: string;
  /** Base64-encoded file content. */
  content: string;
  content_type?: string;
}

export interface ValidatedAttachment {
  filename: string;
  content_type: string;
  size: number;
  content_b64: string;
}

export interface AttachmentMeta {
  filename: string;
  content_type: string;
  size: number;
  /** Present only when BODY_STORAGE=inline (content rides in the row). */
  content_b64?: string;
}

export interface AttachmentMalwareScanner {
  name: string;
  scan(input: { filename: string; content_type: string; content: Buffer }): Promise<{ clean: boolean; threat?: string }>;
}

export type AttachmentScanResult =
  | { ok: true; scanned: boolean }
  | { ok: false; error: 'attachment_malware_detected'; filename: string; threat?: string }
  | { ok: false; error: 'attachment_scan_unavailable'; message: string };

let scannerOverride: AttachmentMalwareScanner | null | undefined;

/** Test/deployment injection seam. undefined restores env configuration. */
export function setAttachmentMalwareScanner(scanner?: AttachmentMalwareScanner | null): void {
  scannerOverride = scanner;
}

/** Minimal clamd INSTREAM client; clamd owns archive recursion/decompression
 * limits, signature updates, and malware identification. */
export class ClamAvAttachmentScanner implements AttachmentMalwareScanner {
  readonly name = 'clamav';

  constructor(
    private readonly host = process.env.CLAMAV_HOST ?? '127.0.0.1',
    private readonly port = Number(process.env.CLAMAV_PORT ?? 3310),
    private readonly timeoutMs = Number(process.env.ATTACHMENT_SCAN_TIMEOUT_MS ?? 10_000),
  ) {}

  scan(input: { filename: string; content_type: string; content: Buffer }): Promise<{ clean: boolean; threat?: string }> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let response = '';
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) return reject(err);
        const normalized = response.replace(/\0/g, '').trim();
        if (/\bOK$/i.test(normalized)) return resolve({ clean: true });
        const found = /:\s*(.+)\s+FOUND$/i.exec(normalized);
        if (found) return resolve({ clean: false, threat: found[1]?.trim() });
        reject(new Error(`Unexpected clamd response: ${normalized.slice(0, 200)}`));
      };
      socket.setTimeout(Number.isFinite(this.timeoutMs) && this.timeoutMs > 0 ? this.timeoutMs : 10_000);
      socket.on('timeout', () => finish(new Error('ClamAV scan timed out')));
      socket.on('error', (err) => finish(err));
      socket.on('data', (chunk) => {
        response += chunk.toString('utf8');
        if (response.length > 4096) return finish(new Error('ClamAV response exceeded limit'));
        if (response.includes('\0') || /(?:OK|FOUND)\s*$/i.test(response.trim())) finish();
      });
      socket.on('end', () => finish());
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < input.content.length; offset += 64 * 1024) {
          const chunk = input.content.subarray(offset, offset + 64 * 1024);
          const size = Buffer.allocUnsafe(4);
          size.writeUInt32BE(chunk.length);
          socket.write(size);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}

function configuredScanner(): AttachmentMalwareScanner | null {
  if (scannerOverride !== undefined) return scannerOverride;
  const mode = (process.env.ATTACHMENT_SCANNER ?? 'off').toLowerCase();
  return mode === 'clamav' ? new ClamAvAttachmentScanner() : null;
}

export async function scanAttachmentsForMalware(
  attachments: ValidatedAttachment[],
  opts: { required?: boolean; failurePolicy?: 'reject' | 'allow' } = {},
): Promise<AttachmentScanResult> {
  if (attachments.length === 0) return { ok: true, scanned: false };
  const scanner = configuredScanner();
  const required = opts.required ?? process.env.ATTACHMENT_SCAN_REQUIRED === 'true';
  const failurePolicy = opts.failurePolicy ?? (process.env.ATTACHMENT_SCAN_FAILURE_POLICY === 'allow' ? 'allow' : 'reject');
  if (!scanner) {
    attachmentScans.inc({ scanner: 'none', outcome: 'skipped' }, attachments.length);
    return required
      ? { ok: false, error: 'attachment_scan_unavailable', message: 'Attachment scanning is required but no scanner is configured.' }
      : { ok: true, scanned: false };
  }

  for (const attachment of attachments) {
    try {
      const result = await scanner.scan({
        filename: attachment.filename,
        content_type: attachment.content_type,
        content: Buffer.from(attachment.content_b64, 'base64'),
      });
      if (!result.clean) {
        attachmentScans.inc({ scanner: scanner.name, outcome: 'infected' });
        return { ok: false, error: 'attachment_malware_detected', filename: attachment.filename, threat: result.threat };
      }
      attachmentScans.inc({ scanner: scanner.name, outcome: 'clean' });
    } catch (err) {
      attachmentScans.inc({ scanner: scanner.name, outcome: 'unavailable' });
      if (failurePolicy === 'allow' && !required) continue;
      return {
        ok: false,
        error: 'attachment_scan_unavailable',
        message: err instanceof Error ? err.message : 'Attachment scanner unavailable',
      };
    }
  }
  return { ok: true, scanned: true };
}

export type AttachmentValidation =
  | { ok: true; attachments: ValidatedAttachment[]; total_bytes: number }
  | { ok: false; error: 'attachment_rejected' | 'attachment_too_large'; message: string };

export const MAX_ATTACHMENTS = Number(process.env.ATTACHMENT_MAX_COUNT ?? 10);
const MAX_BYTES_EACH = Number(process.env.ATTACHMENT_MAX_BYTES ?? 5 * 1024 * 1024);
const MAX_BYTES_TOTAL = Number(process.env.ATTACHMENT_MAX_TOTAL_BYTES ?? 7 * 1024 * 1024);

// Executable / script extensions no mainstream receiver accepts. Blocking
// them here saves the send from a guaranteed downstream rejection (and us
// from being a malware relay). Extendable via ATTACHMENT_BLOCKED_EXTENSIONS.
const DEFAULT_BLOCKED_EXTENSIONS = [
  'exe', 'dll', 'com', 'bat', 'cmd', 'scr', 'pif', 'msi', 'msp', 'jar',
  'js', 'jse', 'vbs', 'vbe', 'ws', 'wsf', 'wsh', 'ps1', 'psm1', 'sh',
  'apk', 'app', 'deb', 'rpm', 'iso', 'img', 'cpl', 'gadget', 'hta',
  'inf', 'lnk', 'reg', 'chm',
];

function blockedExtensions(): Set<string> {
  const extra = (process.env.ATTACHMENT_BLOCKED_EXTENSIONS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  return new Set([...DEFAULT_BLOCKED_EXTENSIONS, ...extra]);
}

function sanitizeFilename(raw: string): string {
  // Strip path components and anything that could smuggle into a MIME header.
  const base = raw.split(/[/\\]/).pop() ?? 'attachment';
  const clean = base.replace(/[\r\n\t"';]/g, '').replace(/[^\x20-\x7E]/g, '_').trim();
  return (clean || 'attachment').slice(0, 255);
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

// Conservative default content types for common document extensions; anything
// unknown falls back to application/octet-stream.
const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  zip: 'application/zip',
  json: 'application/json',
  xml: 'application/xml',
  ics: 'text/calendar',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const BASE64_RE = /^[A-Za-z0-9+/\r\n]+={0,2}$/;

export function validateAttachments(inputs: AttachmentInput[]): AttachmentValidation {
  if (inputs.length > MAX_ATTACHMENTS) {
    return { ok: false, error: 'attachment_rejected', message: `Maximum ${MAX_ATTACHMENTS} attachments per message.` };
  }
  const blocked = blockedExtensions();
  const out: ValidatedAttachment[] = [];
  let total = 0;

  for (const input of inputs) {
    const filename = sanitizeFilename(input.filename);
    const ext = extensionOf(filename);
    if (ext && blocked.has(ext)) {
      return {
        ok: false,
        error: 'attachment_rejected',
        message: `Attachment '${filename}': .${ext} files are not deliverable (blocked by all major receivers).`,
      };
    }

    const b64 = input.content.replace(/\s+/g, '');
    if (b64.length === 0 || !BASE64_RE.test(b64)) {
      return { ok: false, error: 'attachment_rejected', message: `Attachment '${filename}': content must be base64.` };
    }
    // Decoded size from base64 length without materializing the buffer.
    const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    const size = Math.floor((b64.length * 3) / 4) - padding;
    const signature = Buffer.from(b64.slice(0, 128), 'base64');
    if ((signature[0] === 0x4d && signature[1] === 0x5a)
      || (signature[0] === 0x7f && signature.subarray(1, 4).toString('ascii') === 'ELF')) {
      return {
        ok: false,
        error: 'attachment_rejected',
        message: `Attachment '${filename}' contains an executable file signature regardless of its extension.`,
      };
    }
    if (size > MAX_BYTES_EACH) {
      return {
        ok: false,
        error: 'attachment_too_large',
        message: `Attachment '${filename}' is ${size} bytes; the per-attachment limit is ${MAX_BYTES_EACH}.`,
      };
    }
    total += size;
    if (total > MAX_BYTES_TOTAL) {
      return {
        ok: false,
        error: 'attachment_too_large',
        message: `Attachments total ${total} bytes; the per-message limit is ${MAX_BYTES_TOTAL}.`,
      };
    }

    out.push({
      filename,
      content_type: input.content_type?.slice(0, 120) || CONTENT_TYPES[ext] || 'application/octet-stream',
      size,
      content_b64: b64,
    });
  }

  return { ok: true, attachments: out, total_bytes: total };
}
