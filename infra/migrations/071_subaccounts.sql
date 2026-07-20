-- Sub-accounts (reseller / franchise / BPO tenancy).
--
-- A sub-account IS a customers row with parent_customer_id set — so domains,
-- suppressions, API keys, quotas, workflows, analytics, and fail-closed RLS
-- isolation all apply per child with zero additional schema. The parent
-- manages children via /v1/subaccounts, sets their quotas as spend caps, and
-- children's billing access defers to the parent's billing state.
-- Nesting is not allowed (children cannot have children; enforced in the
-- service layer since a CHECK cannot reference other rows).

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS parent_customer_id UUID
        REFERENCES customers(id) ON DELETE RESTRICT
        CHECK (parent_customer_id != id);

CREATE INDEX IF NOT EXISTS idx_customers_parent
    ON customers (parent_customer_id)
    WHERE parent_customer_id IS NOT NULL;
