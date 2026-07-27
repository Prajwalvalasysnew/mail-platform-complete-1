import { describe, expect, it } from 'vitest';
import { oidcAuthenticationContextSatisfied } from '@platform/shared';

describe('production OIDC authentication context policy', () => {
  it('accepts an MFA AMR or matching ACR and rejects password-only tokens', () => {
    expect(oidcAuthenticationContextSatisfied({ amr: ['pwd', 'mfa'] }, 'mfa')).toBe(true);
    expect(oidcAuthenticationContextSatisfied({ acr: 'urn:company:loa:2' }, 'urn:company:loa:2')).toBe(true);
    expect(oidcAuthenticationContextSatisfied({ amr: ['pwd'] }, 'mfa')).toBe(false);
    expect(oidcAuthenticationContextSatisfied({}, 'mfa')).toBe(false);
  });

  it('can require multiple independently asserted contexts', () => {
    expect(oidcAuthenticationContextSatisfied({ amr: ['mfa', 'hwk'] }, 'mfa,hwk')).toBe(true);
    expect(oidcAuthenticationContextSatisfied({ amr: ['mfa'] }, 'mfa,hwk')).toBe(false);
  });
});
