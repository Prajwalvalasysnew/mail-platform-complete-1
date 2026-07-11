-- Refunds and credit notes. A credit note is the provider's record of money
-- returned or written off against an invoice (Stripe credit_note, which backs
-- post-payment refunds and pre-payment adjustments). We store provider-issued
-- credit notes rather than initiating refunds ourselves, so customer-facing
-- billing history and finance exports reflect exactly what the provider issued.
CREATE TABLE IF NOT EXISTS credit_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  provider_credit_note_id TEXT NOT NULL UNIQUE,
  provider_invoice_id TEXT,
  number TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  reason TEXT,
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'void')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_notes_customer ON credit_notes(customer_id, created_at DESC);
