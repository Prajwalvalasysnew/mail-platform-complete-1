-- Legal hold (gap analysis Top-20 #19).
--
-- A legal hold suspends destructive erasure for data covered by its scope, so a
-- GDPR/CCPA "delete my data" request cannot destroy records that are subject to
-- litigation hold, regulatory investigation, or a retention obligation. The
-- acceptance criterion from the report: "Legal hold blocks destructive erasure
-- where required."
--
-- Schema follows the report's spec, with an `active` derivation via released_at
-- (a hold is active while released_at IS NULL).

CREATE TABLE IF NOT EXISTS legal_holds (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    -- What the hold covers:
    --   'customer'         → the entire tenant (all recipients)
    --   'recipient:<email>'→ a single recipient address (lower-cased)
    -- Kept as free text (with a documented convention) so scopes can be
    -- extended without a schema change.
    scope           TEXT NOT NULL,
    reason          TEXT NOT NULL,
    created_by      TEXT,              -- actor label (user email / api key id / admin)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    released_at     TIMESTAMPTZ,       -- NULL = active; set = released
    released_by     TEXT
);

-- Fast lookup of active holds for a tenant (the erasure-time check).
CREATE INDEX IF NOT EXISTS idx_legal_holds_active
    ON legal_holds (customer_id) WHERE released_at IS NULL;

-- Tenant-scoped RLS, matching the permissive 023 pattern (the fail-closed
-- migration tightens it alongside the other tenant tables).
ALTER TABLE legal_holds ENABLE ROW LEVEL SECURITY;
CREATE POLICY legal_holds_tenant ON legal_holds
  USING (customer_id = current_tenant_id() OR current_tenant_id() IS NULL);
