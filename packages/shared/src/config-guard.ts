// Startup configuration guard.
//
// Refuses to boot in production if known-default or missing secrets are present.
// This makes it impossible to accidentally deploy the development credentials
// shipped in .env.example / docker-compose.

const KNOWN_DEFAULTS = new Set<string>([
  'dev-secret-change-in-production-min-32-chars',
  'worker-secret-change-me',
  'dev-admin-token-change-me',
  'change-me-pepper-min-32-chars-required-in-prod',
  'change-me-to-a-long-random-string-min-32-chars',
  'change-me-verp-signing-secret-min-16-chars',
  'change-me-admin-pepper-min-32-chars',
  'change-me',
  'changeme',
  'admin',
  'admin_token',
  'secret',
  'password',
  'mailpass',
]);

/**
 * Heuristic detector for obviously-insecure values that aren't worth
 * enumerating one by one: anything containing "change-me"/"changeme", a value
 * that is all zeros (e.g. the placeholder ENCRYPTION_KEY), or a value composed
 * of a single repeated character. Catches the shipped .env.example placeholders
 * even if their exact text drifts.
 */
function looksInsecure(val: string): boolean {
  const v = val.trim().toLowerCase();
  if (KNOWN_DEFAULTS.has(v)) return true;
  if (v.includes('change-me') || v.includes('changeme') || v.includes('change_me')) return true;
  if (/^0+$/.test(v)) return true; // all-zeros placeholder key
  if (v.length > 1 && /^(.)\1+$/.test(v)) return true; // single repeated char
  if (v.includes('example') || v.includes('placeholder') || v.includes('your-') || v.includes('xxxx')) return true;
  return false;
}

interface SecretRule {
  name: string;
  required: boolean;
  minLength?: number;
}

// Secrets that matter for a secure deployment. `required` ones must be present
// in production; all are checked against the insecure-value heuristic.
const RULES: SecretRule[] = [
  { name: 'JWT_SECRET', required: true, minLength: 32 },
  { name: 'ENCRYPTION_KEY', required: true, minLength: 32 },
  { name: 'VERP_SECRET', required: true, minLength: 16 },
  { name: 'API_KEY_PEPPER', required: true, minLength: 32 },
  { name: 'ADMIN_SESSION_PEPPER', required: true, minLength: 32 },
  { name: 'ADMIN_TOKEN', required: false, minLength: 16 },
  { name: 'HARAKA_OUTBOUND_PASS', required: false },
  { name: 'WORKER_SMTP_PASSWORD', required: false },
  { name: 'REDIS_PASSWORD', required: false },
];

export interface GuardResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Conditional rules for the active billing provider's webhook secret. A real
 * (non-mock) provider that receives webhooks MUST verify their signatures, so
 * the corresponding *_WEBHOOK_SECRET is required in production. We only require
 * the secret for the provider that's actually selected, and only when that
 * provider is configured with live credentials (otherwise it falls back to the
 * mock provider, which doesn't process real webhooks).
 */
function billingWebhookRules(env: NodeJS.ProcessEnv): SecretRule[] {
  const provider = (env.BILLING_PROVIDER ?? (env.STRIPE_SECRET_KEY ? 'stripe' : 'mock')).trim().toLowerCase();
  switch (provider) {
    case 'stripe':
      // Only enforce if Stripe is live-configured (else it's the mock fallback).
      return env.STRIPE_SECRET_KEY ? [{ name: 'STRIPE_WEBHOOK_SECRET', required: true, minLength: 16 }] : [];
    case 'paypal':
      // Selecting PayPal in production is an explicit commitment to its
      // official OAuth-backed webhook verifier. Do not silently fall back to a
      // mock/incomplete provider when BILLING_PROVIDER=paypal is set.
      return [
        { name: 'PAYPAL_CLIENT_ID', required: true, minLength: 8 },
        { name: 'PAYPAL_CLIENT_SECRET', required: true, minLength: 16 },
        { name: 'PAYPAL_WEBHOOK_ID', required: true, minLength: 8 },
      ];
    case 'cashfree':
      return env.CASHFREE_APP_ID && env.CASHFREE_SECRET_KEY
        ? [{ name: 'CASHFREE_WEBHOOK_SECRET', required: true, minLength: 16 }]
        : [];
    default:
      return [];
  }
}

export function checkConfig(env: NodeJS.ProcessEnv = process.env): GuardResult {
  const isProd = env.NODE_ENV === 'production';
  const errors: string[] = [];
  const warnings: string[] = [];

  // Base rules plus any conditional rules that depend on which optional
  // subsystems are active in this deployment (e.g. the selected billing
  // provider's webhook secret). Building the list dynamically means we only
  // demand a Stripe webhook secret when Stripe is actually the active provider.
  const rules: SecretRule[] = [...RULES, ...billingWebhookRules(env)];

  for (const rule of rules) {
    const val = env[rule.name];
    if (!val) {
      if (rule.required && isProd) errors.push(`${rule.name} is required in production but is not set`);
      else if (rule.required) warnings.push(`${rule.name} is not set (required in production)`);
      continue;
    }
    if (looksInsecure(val)) {
      const msg = `${rule.name} is set to a known default/insecure value — change it`;
      if (isProd) errors.push(msg);
      else warnings.push(msg);
    }
    if (rule.minLength && val.length < rule.minLength) {
      const msg = `${rule.name} is shorter than the required ${rule.minLength} characters`;
      if (isProd) errors.push(msg);
      else warnings.push(msg);
    }
  }

  if (isProd) {
    if (env.ADMIN_PASSWORD_LOGIN_DISABLED !== 'true') {
      errors.push('ADMIN_PASSWORD_LOGIN_DISABLED must be true in production; use OIDC/SSO for admin access');
    }
    if (!env.OIDC_ISSUER_URL) errors.push('OIDC_ISSUER_URL is required in production');
    if (!env.OIDC_CLIENT_ID) errors.push('OIDC_CLIENT_ID is required in production');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Enforce the config guard at process start. Logs warnings; in production,
 * throws (refusing to boot) if any hard error is present.
 */
export function enforceConfig(log?: { warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }): void {
  const result = checkConfig();
  for (const w of result.warnings) {
    if (log) log.warn({ config_warning: w }, w);
    else console.warn(`[config] WARNING: ${w}`);
  }
  if (!result.ok) {
    for (const e of result.errors) {
      if (log) log.error({ config_error: e }, e);
      else console.error(`[config] FATAL: ${e}`);
    }
    throw new Error(
      `Refusing to start: ${result.errors.length} insecure/missing secret(s) in production. ` +
        `Fix the above or unset NODE_ENV=production for local dev.`
    );
  }
}
