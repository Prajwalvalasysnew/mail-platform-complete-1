CREATE TABLE customer_campaigns (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 audience_id UUID, template_id UUID,
 from_email TEXT NOT NULL DEFAULT '', from_name TEXT NOT NULL DEFAULT '',
 reply_to TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '',
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','dispatching','queued','failed','cancelled')),
 snapshot JSONB, result JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(customer_id,id)
);
CREATE INDEX customer_campaigns_tenant_created ON customer_campaigns(customer_id,created_at DESC);
ALTER TABLE customer_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_campaigns_tenant ON customer_campaigns FOR ALL
 USING(customer_id=NULLIF(current_setting('app.customer_id',true),'')::uuid)
 WITH CHECK(customer_id=NULLIF(current_setting('app.customer_id',true),'')::uuid);
-- References are validated by tenant-scoped service transactions. Do not
-- cascade template/audience deletion into historical campaign snapshots.
