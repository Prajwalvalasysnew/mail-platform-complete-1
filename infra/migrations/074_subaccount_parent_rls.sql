-- Hierarchical RLS grants for the two explicit parent-management features.
-- These policies do not expose unrelated tenants: the visible/writable row
-- must belong to a direct child of current_tenant_id(). Children cannot see
-- siblings, and nesting is prohibited by the service layer.

CREATE POLICY usage_daily_parent_select ON usage_daily FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM customers child
      WHERE child.id = usage_daily.customer_id
        AND child.parent_customer_id = current_tenant_id()
    )
  );

CREATE POLICY templates_parent_select ON templates FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM customers child
      WHERE child.id = templates.customer_id
        AND child.parent_customer_id = current_tenant_id()
    )
  );

CREATE POLICY templates_parent_insert ON templates FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM customers child
      WHERE child.id = templates.customer_id
        AND child.parent_customer_id = current_tenant_id()
    )
  );

CREATE POLICY templates_parent_update ON templates FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM customers child
      WHERE child.id = templates.customer_id
        AND child.parent_customer_id = current_tenant_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM customers child
      WHERE child.id = templates.customer_id
        AND child.parent_customer_id = current_tenant_id()
    )
  );
