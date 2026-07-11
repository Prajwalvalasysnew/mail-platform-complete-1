-- SCIM provisioning state is tenant-specific.
--
-- A users row is global and can belong to multiple customers. Migration 038
-- stored externalId/managed state on users, which meant one tenant's SCIM
-- deactivation disabled the human in every other tenant. Keep the global
-- columns temporarily for backwards-compatible rollback, but move all active
-- SCIM behavior to the membership row.

ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS scim_managed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS scim_external_id TEXT,
  ADD COLUMN IF NOT EXISTS scim_display_name TEXT,
  ADD COLUMN IF NOT EXISTS scim_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS scim_updated_at TIMESTAMPTZ;

-- The legacy model could not identify which one of a user's tenants owned the
-- externalId. Preserve it on each membership; the next tenant SCIM sync will
-- establish the authoritative value.
UPDATE memberships AS m
SET scim_managed = TRUE,
    scim_external_id = u.scim_external_id,
    scim_display_name = u.name,
    scim_active = (u.status = 'active'),
    scim_updated_at = NOW()
FROM users AS u
WHERE u.id = m.user_id
  AND u.scim_managed = TRUE
  AND m.scim_managed = FALSE;

DROP INDEX IF EXISTS idx_users_scim_external_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_scim_external_id
  ON memberships (customer_id, scim_external_id)
  WHERE scim_external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memberships_scim_active
  ON memberships (customer_id, scim_active)
  WHERE scim_managed = TRUE;
