// Delivery transport abstraction.
// Lets the worker send via Amazon SES (recommended for launch — Amazon owns IP
// reputation) OR via the self-hosted Haraka MTA (when you're ready to own IPs).
// Selected by the DELIVERY_TRANSPORT env var.

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { classifyFailure, type FailureCategory, type RetryStrategy } from './failure-taxonomy.js';

export interface DeliveryResult {
  provider_message_id: string;
  response: string;
  accepted: string[];
  rejected: string[];
}

export interface DeliveryError extends Error {
  permanent: boolean; // true = don't retry (5xx / hard reject)
  code?: string | number;
  response?: string;
  // Rich classification (gap analysis #14): category + retry strategy so the
  // worker can shape retries per ISP-signal instead of a single global curve.
  category?: FailureCategory;
  strategy?: RetryStrategy;
  suppress?: boolean;
}

export interface DeliveryMessage {
  envelopeFrom: string;
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
  messageId: string;
  headers: Record<string, string>;
  attachments?: Array<{ filename: string; content_type: string; content_b64: string }>;
}

/** Map platform attachments to nodemailer's attachment shape. */
function mailAttachments(msg: DeliveryMessage) {
  if (!msg.attachments?.length) return undefined;
  return msg.attachments.map((a) => ({
    filename: a.filename,
    content: Buffer.from(a.content_b64, 'base64'),
    contentType: a.content_type,
  }));
}

export interface Transport {
  readonly name: string;
  send(msg: DeliveryMessage): Promise<DeliveryResult>;
  verify(): Promise<boolean>;
  close(): Promise<void>;
}

function makeDeliveryError(err: any): DeliveryError {
  const code = err.responseCode ?? err.code;
  const de = new Error(err.message ?? 'delivery failed') as DeliveryError;
  de.code = code;
  de.response = err.response;

  // Rich classification. The category/strategy drive per-ISP retry shaping in
  // the worker; `permanent` is kept for backward compatibility and is now
  // derived from the taxonomy (strategy 'no_retry') OR the original 5xx signal.
  const cls = classifyFailure({ code, response: err.response ?? err.message });
  de.category = cls.category;
  de.strategy = cls.strategy;
  de.suppress = cls.suppress;
  de.permanent =
    cls.strategy === 'no_retry' ||
    err.permanent === true ||
    (typeof code === 'number' && code >= 500 && code < 600 && cls.strategy !== 'retry_after_remediation');
  return de;
}

// =====================================================
// SES transport (via SMTP interface — simplest, no AWS SDK needed)
// =====================================================
class SesSmtpTransport implements Transport {
  readonly name = 'ses';
  private transporter: Transporter;

  constructor() {
    const host = process.env.SES_SMTP_HOST ?? 'email-smtp.us-east-1.amazonaws.com';
    const port = Number(process.env.SES_SMTP_PORT ?? 587);
    const user = process.env.SES_SMTP_USER;
    const pass = process.env.SES_SMTP_PASS;
    if (!user || !pass) {
      throw new Error('SES_SMTP_USER and SES_SMTP_PASS are required for SES transport');
    }
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      requireTLS: port === 587,
      auth: { user, pass },
      pool: true,
      maxConnections: Number(process.env.SES_MAX_CONNECTIONS ?? 10),
      maxMessages: 100,
    });
  }

  async send(msg: DeliveryMessage): Promise<DeliveryResult> {
    try {
      const info = await this.transporter.sendMail({
        envelope: { from: msg.envelopeFrom, to: msg.to },
        from: msg.from,
        to: msg.to,
        replyTo: msg.replyTo,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        messageId: msg.messageId,
        headers: msg.headers,
        attachments: mailAttachments(msg),
      });
      return {
        provider_message_id: info.messageId,
        response: info.response,
        accepted: (info.accepted ?? []).map(String),
        rejected: (info.rejected ?? []).map(String),
      };
    } catch (err) {
      throw makeDeliveryError(err);
    }
  }

  async verify(): Promise<boolean> {
    return this.transporter.verify();
  }

  async close(): Promise<void> {
    this.transporter.close();
  }
}

// =====================================================
// Haraka / generic SMTP transport (self-hosted IPs)
// =====================================================
class HarakaSmtpTransport implements Transport {
  readonly name = 'haraka';
  private transporter: Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.HARAKA_OUTBOUND_HOST ?? 'localhost',
      port: Number(process.env.HARAKA_OUTBOUND_PORT ?? 2525),
      secure: false,
      auth: {
        user: process.env.HARAKA_OUTBOUND_USER ?? 'worker',
        pass: process.env.HARAKA_OUTBOUND_PASS ?? 'change-me',
      },
      pool: true,
      maxConnections: 20,
      maxMessages: 1000,
    });
  }

  async send(msg: DeliveryMessage): Promise<DeliveryResult> {
    try {
      const info = await this.transporter.sendMail({
        envelope: { from: msg.envelopeFrom, to: msg.to },
        from: msg.from,
        to: msg.to,
        replyTo: msg.replyTo,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        messageId: msg.messageId,
        headers: msg.headers,
        attachments: mailAttachments(msg),
      });
      return {
        provider_message_id: info.messageId,
        response: info.response,
        accepted: (info.accepted ?? []).map(String),
        rejected: (info.rejected ?? []).map(String),
      };
    } catch (err) {
      throw makeDeliveryError(err);
    }
  }

  async verify(): Promise<boolean> {
    return this.transporter.verify();
  }

  async close(): Promise<void> {
    this.transporter.close();
  }
}

// Local development SMTP capture. This exercises the real SMTP serialization
// and attachment path while guaranteeing that messages stay inside Compose.
class MailpitSmtpTransport implements Transport {
  readonly name = 'mailpit';
  private transporter: Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.MAILPIT_SMTP_HOST ?? 'mailpit',
      port: Number(process.env.MAILPIT_SMTP_PORT ?? 1025),
      secure: false,
    });
  }

  async send(msg: DeliveryMessage): Promise<DeliveryResult> {
    try {
      const info = await this.transporter.sendMail({
        envelope: { from: msg.envelopeFrom, to: msg.to },
        from: msg.from,
        to: msg.to,
        replyTo: msg.replyTo,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        messageId: msg.messageId,
        headers: msg.headers,
        attachments: mailAttachments(msg),
      });
      return {
        provider_message_id: info.messageId,
        response: info.response,
        accepted: (info.accepted ?? []).map(String),
        rejected: (info.rejected ?? []).map(String),
      };
    } catch (err) {
      throw makeDeliveryError(err);
    }
  }

  async verify(): Promise<boolean> {
    return this.transporter.verify();
  }

  async close(): Promise<void> {
    this.transporter.close();
  }
}

// =====================================================
// Sandbox transport — for mp_test_ keys. Accepts everything, delivers nothing.
// Lets customers integrate end-to-end (get message IDs, webhooks fire) without
// sending real mail or touching IP reputation.
// =====================================================
class SandboxTransport implements Transport {
  readonly name = 'sandbox';
  async send(msg: DeliveryMessage): Promise<DeliveryResult> {
    return {
      provider_message_id: `sandbox-${msg.messageId.replace(/[<>]/g, '')}`,
      response: '250 2.0.0 OK sandbox (no real delivery)',
      accepted: [msg.to],
      rejected: [],
    };
  }
  async verify(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
}

// Local live-key sink. Unlike SandboxTransport this is selected by explicit
// environment configuration (`DELIVERY_TRANSPORT=log|capture`) rather than by
// an mp_test_ API key. It lets development and E2E environments exercise the
// complete live-key queue/worker lifecycle without opening an SMTP connection
// or affecting sender reputation.
class LocalSinkTransport implements Transport {
  readonly name: string;

  constructor(kind: 'log' | 'capture') {
    this.name = kind;
  }

  async send(msg: DeliveryMessage): Promise<DeliveryResult> {
    if (this.name === 'capture') {
      capturedDeliveries.push(msg);
      // Keep the development capture bounded so accidentally leaving the
      // transport enabled cannot grow process memory without limit.
      if (capturedDeliveries.length > 1_000) capturedDeliveries.shift();
    }
    return {
      provider_message_id: `${this.name}-${msg.messageId.replace(/[<>]/g, '')}`,
      response: `250 2.0.0 OK ${this.name} transport (no external delivery)`,
      accepted: [msg.to],
      rejected: [],
    };
  }

  async verify(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

const capturedDeliveries: DeliveryMessage[] = [];

/** Test/dev evidence hook for DELIVERY_TRANSPORT=capture. Drains atomically. */
export function drainCapturedDeliveries(): DeliveryMessage[] {
  return capturedDeliveries.splice(0, capturedDeliveries.length);
}

let cachedSandbox: SandboxTransport | null = null;
export function getSandboxTransport(): Transport {
  if (!cachedSandbox) cachedSandbox = new SandboxTransport();
  return cachedSandbox;
}

let cached: Transport | null = null;
let cachedKind: string | null = null;

export function getTransport(): Transport {
  const kind = (process.env.DELIVERY_TRANSPORT ?? 'haraka').toLowerCase();
  if (cached && cachedKind === kind) return cached;

  cached = kind === 'ses'
    ? new SesSmtpTransport()
    : kind === 'mailpit'
      ? new MailpitSmtpTransport()
    : kind === 'log' || kind === 'capture'
      ? new LocalSinkTransport(kind)
      : new HarakaSmtpTransport();
  cachedKind = kind;
  return cached;
}
