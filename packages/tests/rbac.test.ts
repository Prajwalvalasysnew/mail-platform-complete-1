import { describe, it, expect } from 'vitest';
import { roleHasCapability, membershipRoleAtLeast, MEMBERSHIP_ROLE_RANK } from '@platform/shared';

describe('RBAC capabilities', () => {
  it('owner has every capability', () => {
    for (const cap of ['members:manage', 'billing:manage', 'apikeys:manage', 'domains:manage', 'send', 'logs:read', 'settings:manage', 'org:delete'] as const) {
      expect(roleHasCapability('owner', cap)).toBe(true);
    }
  });

  it('admin can manage members but not billing or delete the org', () => {
    expect(roleHasCapability('admin', 'members:manage')).toBe(true);
    expect(roleHasCapability('admin', 'billing:manage')).toBe(false);
    expect(roleHasCapability('admin', 'org:delete')).toBe(false);
  });

  it('developer can send and manage keys but not members', () => {
    expect(roleHasCapability('developer', 'send')).toBe(true);
    expect(roleHasCapability('developer', 'apikeys:manage')).toBe(true);
    expect(roleHasCapability('developer', 'members:manage')).toBe(false);
  });

  it('analyst is read-only', () => {
    expect(roleHasCapability('analyst', 'logs:read')).toBe(true);
    expect(roleHasCapability('analyst', 'send')).toBe(false);
    expect(roleHasCapability('analyst', 'apikeys:manage')).toBe(false);
  });

  it('billing is scoped to billing (plus read)', () => {
    expect(roleHasCapability('billing', 'billing:manage')).toBe(true);
    expect(roleHasCapability('billing', 'logs:read')).toBe(true);
    expect(roleHasCapability('billing', 'send')).toBe(false);
    expect(roleHasCapability('billing', 'members:manage')).toBe(false);
  });

  it('coarse rank puts owner/admin above the siblings', () => {
    expect(membershipRoleAtLeast('owner', 'admin')).toBe(true);
    expect(membershipRoleAtLeast('admin', 'developer')).toBe(true);
    expect(membershipRoleAtLeast('developer', 'admin')).toBe(false);
    expect(MEMBERSHIP_ROLE_RANK.owner).toBeGreaterThan(MEMBERSHIP_ROLE_RANK.admin);
  });
});
