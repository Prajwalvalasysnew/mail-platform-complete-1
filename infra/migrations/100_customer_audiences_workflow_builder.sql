CREATE TABLE audience_collections (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('list','segment')), name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 rules JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(customer_id,id), UNIQUE(customer_id,kind,name)
);
ALTER TABLE audience_contacts ADD CONSTRAINT audience_contacts_tenant_id UNIQUE(customer_id,id);
CREATE TABLE audience_collection_members (
 customer_id UUID NOT NULL, collection_id UUID NOT NULL, contact_id UUID NOT NULL,
 PRIMARY KEY(customer_id,collection_id,contact_id),
 FOREIGN KEY(customer_id,collection_id) REFERENCES audience_collections(customer_id,id) ON DELETE CASCADE,
 FOREIGN KEY(customer_id,contact_id) REFERENCES audience_contacts(customer_id,id) ON DELETE CASCADE
);
ALTER TABLE audience_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE audience_collections FORCE ROW LEVEL SECURITY;
CREATE POLICY audience_collections_tenant ON audience_collections FOR ALL
 USING(customer_id=NULLIF(current_setting('app.customer_id',true),'')::uuid)
 WITH CHECK(customer_id=NULLIF(current_setting('app.customer_id',true),'')::uuid);
ALTER TABLE audience_collection_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE audience_collection_members FORCE ROW LEVEL SECURITY;
CREATE POLICY audience_collection_members_tenant ON audience_collection_members FOR ALL
 USING(customer_id=NULLIF(current_setting('app.customer_id',true),'')::uuid)
 WITH CHECK(customer_id=NULLIF(current_setting('app.customer_id',true),'')::uuid);
ALTER TABLE workflows ADD COLUMN builder_document JSONB, ADD COLUMN builder_revision INTEGER NOT NULL DEFAULT 0 CHECK(builder_revision>=0);
