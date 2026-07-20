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
