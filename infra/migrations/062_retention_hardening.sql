-- Retention hardening (DATABASE_10_10_PLAN Phase 0).
--
-- The retention sweep previously deleted with predicates no index could
-- serve (all existing indexes on these tables lead with other columns), so
-- every nightly run was a sequential scan. These indexes back the batched
-- cutoff scans in packages/shared/src/retention.ts.
--
-- NOTE for large live deployments: the migration runner applies files inside
-- a transaction, so these use plain CREATE INDEX. On a table that is already
-- huge, pre-create the same indexes with CREATE INDEX CONCURRENTLY from psql
-- before deploying; the IF NOT EXISTS here then no-ops.

-- events: retention cutoff scan (occurred_at < $cutoff).
CREATE INDEX IF NOT EXISTS idx_events_occurred ON events (occurred_at);

-- messages: metadata-row retention cutoff scan (queued_at < $cutoff).
CREATE INDEX IF NOT EXISTS idx_messages_queued ON messages (queued_at);

-- tracked_links: never purged before this phase; cutoff scan on created_at.
CREATE INDEX IF NOT EXISTS idx_tracked_links_created ON tracked_links (created_at);

-- webhook_delivery_log: never purged before this phase; cutoff scan on
-- delivered_at (existing index leads with webhook_id).
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_log_delivered
  ON webhook_delivery_log (delivered_at);

-- blocklist_checks: never purged before this phase; cutoff scan on checked_at
-- (existing indexes lead with ip / listed).
CREATE INDEX IF NOT EXISTS idx_blocklist_checks_checked
  ON blocklist_checks (checked_at);

-- legal_holds: the retention sweep now consults active holds on every
-- destructive step via NOT EXISTS (customer_id, scope). The existing partial
-- index idx_legal_holds_active(customer_id) WHERE released_at IS NULL already
-- serves that probe; nothing further needed here.
