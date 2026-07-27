-- PCI-03 (compliance implementation plan): billing webhook payload minimization.
--
-- billing_events.payload previously stored the ENTIRE provider event so the
-- admin replay tool could re-run it (035_billing_event_payload.sql). Going
-- forward the application reduces every payload to the fields the replay
-- parsers actually read (packages/shared/src/billing-payload-allowlist.ts).
--
-- This migration handles the rows already written under the old behaviour.
-- An allowlist cannot be reconstructed in SQL for every provider shape, so
-- legacy rows are scrubbed with a DENYLIST of the subtrees that carry payment
-- instrument and payer contact data. That is deliberately the weaker of the
-- two mechanisms: it is a one-time remediation of historical rows, while the
-- allowlist is the ongoing control for all new writes.
--
-- The `#-` operator deletes a path if present and is a no-op otherwise, so
-- this is safe across mixed provider shapes and already-clean rows.

UPDATE billing_events
SET payload = payload
      #- '{data,object,charges}'
      #- '{data,object,payment_intent}'
      #- '{data,object,payment_method_details}'
      #- '{data,object,default_payment_method}'
      #- '{data,object,customer_details}'
      #- '{data,object,payment_settings}'
      #- '{data,object,last_payment_error}'
      #- '{resource,billing_info,last_payment}'
      #- '{resource,subscriber,shipping_address}'
      #- '{resource,subscriber,payment_source}'
      #- '{data,payment_method}'
      #- '{data,subscription,customer_details,customer_email}'
      #- '{data,subscription,customer_details,customer_phone}'
WHERE payload IS NOT NULL;

-- Retention. A stored payload only has operational value while replaying the
-- event is still plausible; after that it is retained provider data with no
-- purpose (BASE-06). The row itself is KEPT forever — it is the idempotency
-- marker — but the payload is nulled by the retention sweep, which reports the
-- event as "not replayable", exactly like a pre-035 row.
CREATE INDEX IF NOT EXISTS idx_billing_events_payload_retention
  ON billing_events (processed_at)
  WHERE payload IS NOT NULL;
