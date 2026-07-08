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

let cachedSandbox: SandboxTransport | null = null;
export function getSandboxTransport(): Transport {
  if (!cachedSandbox) cachedSandbox = new SandboxTransport();
  return cachedSandbox;
}

let cached: Transport | null = null;

export function getTransport(): Transport {
  if (cached) return cached;
  const kind = (process.env.DELIVERY_TRANSPORT ?? 'haraka').toLowerCase();
  cached = kind === 'ses' ? new SesSmtpTransport() : new HarakaSmtpTransport();
  return cached;
}
