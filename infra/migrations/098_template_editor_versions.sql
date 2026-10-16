-- Persist the editor document alongside the rendered template. A revision is
-- used for optimistic concurrency; historical versions are immutable snapshots.
ALTER TABLE templates ADD COLUMN IF NOT EXISTS editor_document JSONB;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE templates ADD CONSTRAINT templates_revision_positive CHECK (revision > 0);

CREATE TABLE template_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  html_body TEXT,
  text_body TEXT,
  editor_document JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, revision)
);
CREATE INDEX template_versions_customer_template ON template_versions(customer_id, template_id, revision DESC);
ALTER TABLE template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY template_versions_tenant ON template_versions FOR ALL
  USING (customer_id = NULLIF(current_setting('app.customer_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('app.customer_id', true), '')::uuid);

INSERT INTO template_versions(customer_id, template_id, revision, name, subject, html_body, text_body, editor_document, created_at)
SELECT customer_id, id, revision, name, subject, html_body, text_body, editor_document, updated_at
FROM templates;
