-- Webhook delivery log: one row per attempt so operators can inspect
-- delivery history, debug endpoint failures, and audit retry patterns.
CREATE TABLE IF NOT EXISTS webhook_delivery_log (
  id           BIGSERIAL PRIMARY KEY,
  webhook_id   UUID    NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id     BIGINT  REFERENCES events(id) ON DELETE SET NULL,
  event_type   TEXT    NOT NULL,
  attempt      INT     NOT NULL DEFAULT 1,
  status_code  INT,
  outcome      TEXT    NOT NULL CHECK (outcome IN ('success','failure','dropped','blocked')),
  duration_ms  INT,
  error        TEXT,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary access pattern: newest deliveries for a given webhook, paginated.
CREATE INDEX IF NOT EXISTS webhook_delivery_log_webhook_delivered
  ON webhook_delivery_log (webhook_id, delivered_at DESC);

-- Sparse index for joining delivery rows back to the source event.
CREATE INDEX IF NOT EXISTS webhook_delivery_log_event_id
  ON webhook_delivery_log (event_id)
  WHERE event_id IS NOT NULL;
