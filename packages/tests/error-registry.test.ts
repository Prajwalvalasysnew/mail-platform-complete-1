// Error-code registry guard (gap analysis Top-20 #20, §23.3.5 item 4).
//
// Enforces the API error-code stability contract two ways:
//   1. COMPLETENESS — every `error: '<code>'` a route handler emits must be
//      registered in ERROR_CODES, so no undocumented code leaks into the public
//      contract. Statically scans the route source (no DB).
//   2. BACKWARD COMPAT — a frozen baseline of shipped codes; the registry must
//      never DROP a code that has been shipped (renaming/removing a code is a
//      breaking change for clients that branch on it). Adding codes is fine.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES, listErrorCodes, isRegisteredErrorCode } from '@platform/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const routesDir = path.join(repoRoot, 'packages', 'api', 'src', 'routes');
const pluginsDir = path.join(repoRoot, 'packages', 'api', 'src', 'plugins');

// Extract every string used as `error: '<code>'` (and `error: "<code>"`) from
// the API source. This is the set of machine-readable codes clients can see.
function emittedErrorCodes(): Set<string> {
  const codes = new Set<string>();
  const files = [
    ...readdirSync(routesDir).filter((f) => f.endsWith('.ts')).map((f) => path.join(routesDir, f)),
    ...readdirSync(pluginsDir).filter((f) => f.endsWith('.ts')).map((f) => path.join(pluginsDir, f)),
  ];
  const re = /\berror:\s*['"]([a-z][a-z0-9_]*)['"]/g;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      if (m[1]) codes.add(m[1]);
    }
  }
  return codes;
}

describe('error-code registry completeness', () => {
  it('every error code emitted by the API is registered', () => {
    const emitted = [...emittedErrorCodes()].sort();
    const unregistered = emitted.filter((c) => !isRegisteredErrorCode(c));
    expect(
      unregistered,
      `These error codes are returned by routes but missing from ERROR_CODES ` +
        `(packages/shared/src/error-codes.ts). Add them with a description + httpStatus:\n${unregistered.join('\n')}`
    ).toEqual([]);
  });

  it('every registered code has a description and a plausible HTTP status', () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      expect(spec.description.length, `${code} needs a description`).toBeGreaterThan(3);
      expect(spec.httpStatus, `${code} needs a 4xx/5xx status`).toBeGreaterThanOrEqual(400);
      expect(spec.httpStatus).toBeLessThan(600);
    }
  });
});

describe('error-code registry backward compatibility', () => {
  // Frozen baseline: codes shipped as of this guard's introduction. The
  // registry must always be a SUPERSET of this. Removing/renaming a code is a
  // breaking change — deprecate (keep returning it) instead. When you
  // intentionally sunset a code after a deprecation cycle, remove it here too,
  // in the same change, with justification in the PR.
  const BASELINE = [
    'account_locked', 'account_suspended', 'admin_auth_required', 'already_dispatched',
    'backpressure', 'billing_inactive', 'cancelled_by_user', 'cannot_self_demote',
    'content_rejected', 'delivery_not_found', 'domain_exists', 'domain_not_registered',
    'domain_not_verified', 'email_exists', 'email_not_verified', 'forbidden',
    'idempotency_in_progress', 'idempotency_key_reused', 'insufficient_role',
    'internal_error', 'invalid_admin_session', 'invalid_assignee', 'invalid_code',
    'invalid_credentials', 'invalid_delivery_id', 'invalid_idempotency_key', 'invalid_json',
    'invalid_mfa_code', 'invalid_or_expired_token', 'invalid_signature', 'invalid_template',
    'invalid_token', 'kyc_required', 'list_quality_too_low', 'mfa_invalid', 'mfa_required',
    'missing_content', 'missing_subject', 'missing_template_variables', 'name_exists',
    'no_active_org', 'no_fields', 'no_fields_provided', 'no_source_event', 'not_a_member',
    'not_authorized', 'not_cancellable', 'not_found', 'not_replayable', 'oidc_not_configured',
    'only_owner_can_grant_owner', 'only_owner_can_manage_owner', 'only_owner_can_remove_owner',
    'org_exists', 'password_login_disabled', 'pool_capacity_exceeded', 'pool_paused',
    'queue_backpressure', 'quota_exceeded', 'rate_limited', 'request_error', 'source_event_gone',
    'template_not_found', 'token_expired', 'unparseable_payload', 'unsubscribe_group_not_found',
    'unsupported_billing_provider', 'unsupported_source_queue', 'validation_failed', 'webhook_disabled',
  ];

  it('the registry still contains every baseline (previously-shipped) code', () => {
    const registered = new Set(listErrorCodes());
    const dropped = BASELINE.filter((c) => !registered.has(c));
    expect(
      dropped,
      `These previously-shipped error codes were removed from ERROR_CODES — that is ` +
        `a BREAKING change for clients. Restore them, or if intentionally sunset after ` +
        `a deprecation cycle, update the BASELINE in the same change:\n${dropped.join('\n')}`
    ).toEqual([]);
  });
});
