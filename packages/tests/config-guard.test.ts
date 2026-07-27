import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';

// A genuinely strong secret of a given byte length (hex-encoded random).
function strong(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('hex');
}

describe('config guard', () => {
  it('blocks production with default/short secrets', async () => {
    const { checkConfig } = await import('@platform/shared');
    const r = checkConfig({
      NODE_ENV: 'production',
      JWT_SECRET: 'dev-secret-change-in-production-min-32-chars',
      ENCRYPTION_KEY: 'short',
      VERP_SECRET: 'change-me',
    } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('passes production with strong secrets', async () => {
    const { checkConfig } = await import('@platform/shared');
    const r = checkConfig({
      NODE_ENV: 'production',
      JWT_SECRET: strong(20),
      ENCRYPTION_KEY: strong(32),
      VERP_SECRET: strong(12),
      API_KEY_PEPPER: strong(20),
      ADMIN_SESSION_PEPPER: strong(20),
      ADMIN_PASSWORD_LOGIN_DISABLED: 'true',
      OIDC_ISSUER_URL: 'https://idp.test',
      OIDC_CLIENT_ID: 'mail-platform-admin',
      OIDC_REQUIRED_AUTH_CONTEXT: 'mfa',
      KMS_PROVIDER: 'env',
      KMS_ALLOW_ENV_IN_PRODUCTION: 'true',
      AUDIT_SIGNING_KEY_PEM: 'test-ed25519-private-key',
      AUDIT_WORM_PROVIDER: 's3',
      AUDIT_WORM_S3_BUCKET: 'immutable-audit-test',
      AUDIT_WORM_S3_KMS_KEY_ID: 'arn:aws:kms:us-east-1:123456789012:key/test-audit-key',
    } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('refuses a plaintext environment master key in production by default', async () => {
    const { checkConfig } = await import('@platform/shared');
    const r = checkConfig({
      NODE_ENV: 'production',
      JWT_SECRET: strong(20),
      ENCRYPTION_KEY: strong(32),
      VERP_SECRET: strong(12),
      API_KEY_PEPPER: strong(20),
      ADMIN_SESSION_PEPPER: strong(20),
      ADMIN_PASSWORD_LOGIN_DISABLED: 'true',
      OIDC_ISSUER_URL: 'https://idp.test',
      OIDC_CLIENT_ID: 'mail-platform-admin',
      OIDC_REQUIRED_AUTH_CONTEXT: 'mfa',
      KMS_PROVIDER: 'env',
      AUDIT_SIGNING_KEY_PEM: 'test-ed25519-private-key',
      AUDIT_WORM_PROVIDER: 's3',
      AUDIT_WORM_S3_BUCKET: 'immutable-audit-test',
      AUDIT_WORM_S3_KMS_KEY_ID: 'arn:aws:kms:us-east-1:123456789012:key/test-audit-key',
    } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('KMS_PROVIDER=env is refused'))).toBe(true);
  });

  it('requires the selected remote KMS provider configuration', async () => {
    const { checkConfig } = await import('@platform/shared');
    const r = checkConfig({
      NODE_ENV: 'production',
      JWT_SECRET: strong(20),
      VERP_SECRET: strong(12),
      API_KEY_PEPPER: strong(20),
      ADMIN_SESSION_PEPPER: strong(20),
      ADMIN_PASSWORD_LOGIN_DISABLED: 'true',
      OIDC_ISSUER_URL: 'https://idp.test',
      OIDC_CLIENT_ID: 'mail-platform-admin',
      OIDC_REQUIRED_AUTH_CONTEXT: 'mfa',
      KMS_PROVIDER: 'aws',
      AUDIT_SIGNING_KEY_PEM: 'test-ed25519-private-key',
      AUDIT_WORM_PROVIDER: 's3',
      AUDIT_WORM_S3_BUCKET: 'immutable-audit-test',
      AUDIT_WORM_S3_KMS_KEY_ID: 'arn:aws:kms:us-east-1:123456789012:key/test-audit-key',
    } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('AWS_KMS_ENCRYPTED_KEY'))).toBe(true);
    expect(r.errors.some((e) => e.includes('AWS_REGION'))).toBe(true);
    expect(r.errors.some((e) => e.includes('ENCRYPTION_KEY'))).toBe(false);
  });

  it('never blocks in development (warnings only)', async () => {
    const { checkConfig } = await import('@platform/shared');
    const r = checkConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(true);
  });

  it('catches the shipped .env.example placeholders in production', async () => {
    const { checkConfig } = await import('@platform/shared');
    const r = checkConfig({
      NODE_ENV: 'production',
      JWT_SECRET: 'change-me-to-a-long-random-string-min-32-chars',
      ENCRYPTION_KEY: '0'.repeat(64), // all-zeros placeholder
      VERP_SECRET: 'change-me-verp-signing-secret-min-16-chars',
      API_KEY_PEPPER: 'change-me-pepper-min-32-chars-required-in-prod',
      ADMIN_SESSION_PEPPER: 'change-me-admin-pepper-min-32-chars',
      ADMIN_PASSWORD_LOGIN_DISABLED: 'false',
    } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    // Every one of the five placeholder secrets should be flagged.
    expect(r.errors.length).toBeGreaterThanOrEqual(5);
  });

  it('flags missing required peppers in production', async () => {
    const { checkConfig } = await import('@platform/shared');
    const r = checkConfig({
      NODE_ENV: 'production',
      JWT_SECRET: strong(20),
      ENCRYPTION_KEY: strong(20),
      VERP_SECRET: strong(12),
      // API_KEY_PEPPER and ADMIN_SESSION_PEPPER intentionally omitted
    } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('API_KEY_PEPPER'))).toBe(true);
    expect(r.errors.some((e) => e.includes('ADMIN_SESSION_PEPPER'))).toBe(true);
  });

  it('requires SSO posture for production admin access', async () => {
    const { checkConfig } = await import('@platform/shared');
    const r = checkConfig({
      NODE_ENV: 'production',
      JWT_SECRET: strong(20),
      ENCRYPTION_KEY: strong(20),
      VERP_SECRET: strong(12),
      API_KEY_PEPPER: strong(20),
      ADMIN_SESSION_PEPPER: strong(20),
      ADMIN_PASSWORD_LOGIN_DISABLED: 'false',
    } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('ADMIN_PASSWORD_LOGIN_DISABLED'))).toBe(true);
    expect(r.errors.some((e) => e.includes('OIDC_ISSUER_URL'))).toBe(true);
    expect(r.errors.some((e) => e.includes('OIDC_CLIENT_ID'))).toBe(true);
  });
});
