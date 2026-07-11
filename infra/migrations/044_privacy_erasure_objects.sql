-- Durable per-object status for privacy erasure. A request must not be marked
-- completed until every orphaned body object has actually been removed.
CREATE TABLE IF NOT EXISTS deletion_object_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deletion_request_id UUID NOT NULL REFERENCES deletion_requests(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  storage_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deletion_request_id, object_key)
);
CREATE INDEX IF NOT EXISTS idx_deletion_object_retry
  ON deletion_object_items(status, updated_at) WHERE status <> 'completed';
