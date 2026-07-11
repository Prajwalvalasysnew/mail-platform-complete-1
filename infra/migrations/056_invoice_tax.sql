-- Store provider-calculated tax on invoices (Stripe Tax / externally computed
-- VAT/GST/sales tax). We persist the amount the provider assessed rather than
-- computing tax ourselves, so finance exports and customer-facing invoices show
-- the tax the customer was actually charged.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_cents INTEGER NOT NULL DEFAULT 0;
