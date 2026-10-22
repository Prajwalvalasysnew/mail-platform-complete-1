CREATE TABLE audience_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  email TEXT NOT NULL CHECK(email = lower(email)),
  name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Subscribed','Unsubscribed')),
  consent_confirmed_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'Customer console',
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(customer_id,email)
);
CREATE INDEX audience_contacts_customer_created ON audience_contacts(customer_id,created_at DESC,id);
ALTER TABLE audience_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE audience_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY audience_contacts_tenant ON audience_contacts FOR ALL
  USING(customer_id=NULLIF(current_setting('app.customer_id',true),'')::uuid)
  WITH CHECK(customer_id=NULLIF(current_setting('app.customer_id',true),'')::uuid);
