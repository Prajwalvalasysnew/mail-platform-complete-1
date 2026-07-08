// Unit tests for the platform mailer: the pluggable provider, the env-based
// default selection, and the rendered transactional templates. No DB needed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CapturingPlatformMailer,
  LoggingPlatformMailer,
  TransportPlatformMailer,
  getPlatformMailer,
  setPlatformMailer,
  sendEmailVerificationEmail,
  sendPasswordResetEmail,
  sendTeamInviteEmail,
} from '@platform/shared';

let cap: CapturingPlatformMailer;

beforeEach(() => {
  cap = new CapturingPlatformMailer();
  setPlatformMailer(cap);
});

afterEach(() => {
  setPlatformMailer(null);
});

describe('platform mailer provider', () => {
  it('CapturingPlatformMailer records sent emails', async () => {
    await cap.send({ to: 'a@example.com', subject: 'Hi', html: '<p>x</p>', text: 'x' });
    expect(cap.sent).toHaveLength(1);
    expect(cap.last()?.to).toBe('a@example.com');
  });

  it('to() filters by recipient case-insensitively', async () => {
    await cap.send({ to: 'User@Example.com', subject: 's', html: 'h', text: 't' });
    expect(cap.to('user@example.com')).toHaveLength(1);
  });

  it('setPlatformMailer overrides and getPlatformMailer returns it', () => {
    const other = new LoggingPlatformMailer(() => {});
    setPlatformMailer(other);
    expect(getPlatformMailer().name).toBe('log');
  });

  it('env PLATFORM_MAIL_DELIVERY selects the provider when unset by caller', () => {
    setPlatformMailer(null);
    const prev = process.env.PLATFORM_MAIL_DELIVERY;
    process.env.PLATFORM_MAIL_DELIVERY = 'transport';
    expect(getPlatformMailer()).toBeInstanceOf(TransportPlatformMailer);
    setPlatformMailer(null);
    process.env.PLATFORM_MAIL_DELIVERY = prev;
  });
});

describe('transactional templates', () => {
  it('verification email carries the token in a verify-email link', async () => {
    await sendEmailVerificationEmail({ to: 'new@example.com', token: 'tok-verify-123', name: 'Ada' });
    const email = cap.last()!;
    expect(email.to).toBe('new@example.com');
    expect(email.subject).toMatch(/verify/i);
    expect(email.html).toContain('/verify-email?token=tok-verify-123');
    expect(email.text).toContain('/verify-email?token=tok-verify-123');
    expect(email.html).toContain('Ada');
  });

  it('password reset email carries the token in a reset-password link', async () => {
    await sendPasswordResetEmail({ to: 'reset@example.com', token: 'tok-reset-xyz' });
    const email = cap.last()!;
    expect(email.subject).toMatch(/reset/i);
    expect(email.html).toContain('/reset-password?token=tok-reset-xyz');
    expect(email.text).toContain('/reset-password?token=tok-reset-xyz');
  });

  it('invite email carries the token and the org name', async () => {
    await sendTeamInviteEmail({ to: 'invitee@example.com', token: 'tok-invite-9', orgName: 'Acme Inc', inviterName: 'boss@acme.com' });
    const email = cap.last()!;
    expect(email.subject).toContain('Acme Inc');
    expect(email.html).toContain('/accept-invite?token=tok-invite-9');
    expect(email.html).toContain('Acme Inc');
    expect(email.html).toContain('boss@acme.com');
  });

  it('url-encodes tokens with special characters', async () => {
    await sendPasswordResetEmail({ to: 'x@example.com', token: 'a b/c+d' });
    const email = cap.last()!;
    expect(email.html).toContain('token=a%20b%2Fc%2Bd');
  });

  it('invite email degrades gracefully without an org name', async () => {
    await sendTeamInviteEmail({ to: 'i@example.com', token: 't' });
    const email = cap.last()!;
    expect(email.subject).toMatch(/invited to a team/i);
    expect(email.html).toContain('/accept-invite?token=t');
  });
});
