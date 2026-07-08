-- AI-ready support triage fields.
--
-- These keep model output separate from human-authored ticket data. The first
-- provider is a deterministic local fallback; a fine-tuned model can later
-- write the same fields through the inference provider interface.

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS ai_summary TEXT,
  ADD COLUMN IF NOT EXISTS ai_suggested_priority TEXT
    CHECK (ai_suggested_priority IS NULL OR ai_suggested_priority IN ('low', 'normal', 'high', 'urgent')),
  ADD COLUMN IF NOT EXISTS ai_suggested_category TEXT
    CHECK (ai_suggested_category IS NULL OR ai_suggested_category IN ('general', 'billing', 'deliverability', 'technical', 'abuse', 'account')),
  ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS ai_labels TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS ai_model TEXT,
  ADD COLUMN IF NOT EXISTS ai_triaged_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_support_tickets_ai_triaged
  ON support_tickets (ai_triaged_at DESC)
  WHERE ai_triaged_at IS NOT NULL;
