// Platform mailer — outbound transactional email the *platform itself* sends to
// humans (email verification, password reset, team invites). This is distinct
// from customer mail, which flows through /v1/send, the messages table, quota,
// abuse scanning, and the worker. Platform mail must never count against a
// customer's quota or hit the abuse pipeline, so it has its own thin path.
//
// The mailer is a pluggable provider (same pattern as inference.ts / kms.ts):
//   - TransportPlatformMailer: real delivery via the configured Transport
//     (SES or Haraka). Used in production.
//   - LoggingPlatformMailer: logs the rendered email; for local dev without an
//     MTA configured.
//   - CapturingPlatformMailer: records sent emails in memory so tests can
//     assert on them.
//
// Selection is by env (see getPlatformMailer); tests override with
// setPlatformMailer(new CapturingPlatformMailer()).

import { getTransport } from './transport.js';

export interface PlatformEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface PlatformMailer {
  readonly name: string;
  send(email: PlatformEmail): Promise<void>;
}

function platformFrom(): string {
  return process.env.PLATFORM_MAIL_FROM || `no-reply@${process.env.PLATFORM_DOMAIN || 'localhost'}`;
}

// Where the human-facing app lives. Verification/reset/invite links point here.
// The frontend is not built yet, but the links are real and stable so they work
// the moment a UI exists at these paths.
function appBaseUrl(): string {
  const raw = process.env.APP_BASE_URL || `https://${process.env.PLATFORM_DOMAIN || 'localhost'}`;
  return raw.replace(/\/+$/, '');
}

/** Real delivery via the configured Transport (SES / Haraka). */
export class TransportPlatformMailer implements PlatformMailer {
  readonly name = 'transport';
  async send(email: PlatformEmail): Promise<void> {
    const from = platformFrom();
    const messageId = `<plat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@${process.env.PLATFORM_DOMAIN || 'localhost'}>`;
    await getTransport().send({
      envelopeFrom: from,
      from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      messageId,
      headers: { 'Auto-Submitted': 'auto-generated', 'X-MP-Platform-Mail': 'transactional' },
    });
  }
}

/** Logs the rendered email instead of delivering it. Local-dev default. */
export class LoggingPlatformMailer implements PlatformMailer {
  readonly name = 'log';
  constructor(private readonly log: (o: unknown, m?: string) => void = (o, m) => console.log(m ?? 'platform-mail', o)) {}
  async send(email: PlatformEmail): Promise<void> {
    this.log({ to: email.to, subject: email.subject }, 'platform-mail (not delivered: logging mailer)');
  }
}

/** Captures sent emails in memory for assertions in tests. */
export class CapturingPlatformMailer implements PlatformMailer {
  readonly name = 'capture';
  readonly sent: PlatformEmail[] = [];
  async send(email: PlatformEmail): Promise<void> {
    this.sent.push(email);
  }
  reset(): void {
    this.sent.length = 0;
  }
  last(): PlatformEmail | undefined {
    return this.sent[this.sent.length - 1];
  }
  to(addr: string): PlatformEmail[] {
    return this.sent.filter((e) => e.to.toLowerCase() === addr.toLowerCase());
  }
}

let mailer: PlatformMailer | null = null;

function defaultMailer(): PlatformMailer {
  const mode = (process.env.PLATFORM_MAIL_DELIVERY || '').toLowerCase();
  if (mode === 'transport') return new TransportPlatformMailer();
  if (mode === 'capture') return new CapturingPlatformMailer();
  if (mode === 'log') return new LoggingPlatformMailer();
  // No explicit mode: deliver for real in production, capture under test, log otherwise.
  if (process.env.NODE_ENV === 'production') return new TransportPlatformMailer();
  if (process.env.NODE_ENV === 'test') return new CapturingPlatformMailer();
  return new LoggingPlatformMailer();
}

export function getPlatformMailer(): PlatformMailer {
  if (!mailer) mailer = defaultMailer();
  return mailer;
}

export function setPlatformMailer(next: PlatformMailer | null): void {
  mailer = next;
}

// ---------------------------------------------------------------------------
// Templated transactional emails. Each renders html + text and delivers via the
// active mailer. Kept deliberately plain-HTML (no template engine dependency).
// ---------------------------------------------------------------------------

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,Arial,sans-serif;line-height:1.5;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px">
<h2 style="margin:0 0 16px">${title}</h2>
${bodyHtml}
<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0">
<p style="color:#888;font-size:12px">If you didn't expect this email, you can safely ignore it.</p>
</body></html>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:24px 0"><a href="${href}" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${label}</a></p>
<p style="color:#666;font-size:13px">Or paste this link into your browser:<br><span style="word-break:break-all">${href}</span></p>`;
}

export async function sendEmailVerificationEmail(input: { to: string; token: string; name?: string | null }): Promise<void> {
  const link = `${appBaseUrl()}/verify-email?token=${encodeURIComponent(input.token)}`;
  const greeting = input.name ? `Hi ${input.name},` : 'Hi,';
  await getPlatformMailer().send({
    to: input.to,
    subject: 'Verify your email address',
    html: layout('Verify your email', `<p>${greeting}</p><p>Confirm your email address to finish setting up your account.</p>${button(link, 'Verify email')}`),
    text: `${greeting}\n\nConfirm your email address to finish setting up your account:\n${link}\n\nIf you didn't expect this email, you can ignore it.`,
  });
}

export async function sendPasswordResetEmail(input: { to: string; token: string }): Promise<void> {
  const link = `${appBaseUrl()}/reset-password?token=${encodeURIComponent(input.token)}`;
  await getPlatformMailer().send({
    to: input.to,
    subject: 'Reset your password',
    html: layout('Reset your password', `<p>We received a request to reset your password. This link expires soon.</p>${button(link, 'Reset password')}`),
    text: `We received a request to reset your password. This link expires soon:\n${link}\n\nIf you didn't request this, you can ignore it — your password won't change.`,
  });
}

export async function sendApiSignupVerificationEmail(input: { to: string; token: string }): Promise<void> {
  const link = `${appBaseUrl()}/verify-email?token=${encodeURIComponent(input.token)}`;
  await getPlatformMailer().send({
    to: input.to,
    subject: 'Verify your email to start sending',
    html: layout('Verify your email', `<p>Thanks for signing up. Verify your email address to unlock your sending quota.</p>${button(link, 'Verify email')}`),
    text: `Thanks for signing up.\n\nVerify your email address to unlock your sending quota:\n${link}\n\nIf you didn't create this account, you can safely ignore this email.`,
  });
}

export async function sendQuotaWarningEmail(input: {
  to: string;
  scope: 'daily' | 'monthly';
  threshold: number;
  used: number;
  limit: number;
}): Promise<void> {
  const pct = Math.round((input.used / input.limit) * 100);
  const subject = input.threshold >= 100
    ? `Your ${input.scope} send quota is exhausted`
    : `${pct}% of your ${input.scope} send quota used`;
  const detail = `You've used <strong>${input.used.toLocaleString()}</strong> of <strong>${input.limit.toLocaleString()}</strong> ${input.scope} emails (${pct}%).`;
  const note = input.threshold >= 100
    ? '<p>Sending is paused until the quota resets. Upgrade your plan to continue sending.</p>'
    : '<p>Consider upgrading your plan if you expect to need more capacity.</p>';
  await getPlatformMailer().send({
    to: input.to,
    subject,
    html: layout(subject, `<p>${detail}</p>${note}`),
    text: `You've used ${input.used.toLocaleString()} of ${input.limit.toLocaleString()} ${input.scope} emails (${pct}%).\n\n${input.threshold >= 100 ? 'Sending is paused until the quota resets. Upgrade your plan to continue sending.' : 'Consider upgrading your plan if you need more capacity.'}`,
  });
}

export async function sendTeamInviteEmail(input: { to: string; token: string; orgName?: string | null; inviterName?: string | null }): Promise<void> {
  const link = `${appBaseUrl()}/accept-invite?token=${encodeURIComponent(input.token)}`;
  const org = input.orgName ? `<strong>${input.orgName}</strong>` : 'a team';
  const by = input.inviterName ? ` by ${input.inviterName}` : '';
  await getPlatformMailer().send({
    to: input.to,
    subject: input.orgName ? `You've been invited to ${input.orgName}` : "You've been invited to a team",
    html: layout("You've been invited", `<p>You've been invited${by} to join ${org}.</p>${button(link, 'Accept invitation')}`),
    text: `You've been invited${by} to join ${input.orgName || 'a team'}.\n\nAccept the invitation:\n${link}`,
  });
}

export async function sendDunningEmail(input: {
  to: string;
  stage: 'payment_failed' | 'grace_ending' | 'restricted' | 'recovered';
  graceEndsAt?: Date | null;
}): Promise<void> {
  const billingUrl = `${appBaseUrl()}/billing`;
  const copy = input.stage === 'payment_failed'
    ? { subject: 'Payment failed — update your billing method', text: `We could not collect your latest payment. Sending remains available during the grace period until ${input.graceEndsAt?.toISOString() ?? 'the displayed deadline'}.` }
    : input.stage === 'grace_ending'
      ? { subject: 'Your billing grace period ends soon', text: `Update your payment method before ${input.graceEndsAt?.toISOString() ?? 'the grace deadline'} to avoid sending interruption.` }
      : input.stage === 'restricted'
        ? { subject: 'Sending restricted due to unpaid billing', text: 'Your billing grace period has ended and new sending is restricted. Update your payment method to restore service.' }
        : { subject: 'Payment recovered — sending restored', text: 'Your payment succeeded and normal sending access has been restored.' };
  await getPlatformMailer().send({
    to: input.to, subject: copy.subject,
    html: layout(copy.subject, `<p>${copy.text}</p>${button(billingUrl, 'Manage billing')}`),
    text: `${copy.text}\n\nManage billing: ${billingUrl}`,
  });
}
