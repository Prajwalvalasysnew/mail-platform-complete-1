-- Rich, idempotent local demo data for the admin console.
-- Intended only for the docker-compose development database.

BEGIN;

INSERT INTO customers (
  id, email, name, tier, daily_quota, monthly_quota, status,
  billing_status, billing_provider, kyc_level, kyc_status,
  email_verified_at, created_at
) VALUES
  ('10000000-0000-4000-8000-000000000001', 'ops@acme.example',       'Acme Commerce',      'enterprise', 250000, 7500000, 'active',    'active',   'stripe',   'business', 'approved', now(), now() - interval '14 months'),
  ('10000000-0000-4000-8000-000000000002', 'team@northstar.example','Northstar Health',    'paid',        50000, 1500000, 'active',    'active',   'cashfree', 'payment',  'pending',  now(), now() - interval '8 months'),
  ('10000000-0000-4000-8000-000000000003', 'admin@orbit.example',   'Orbit Education',     'paid',        25000,  750000, 'active',    'past_due', 'paypal',   'domain',   'more_info',now(), now() - interval '5 months'),
  ('10000000-0000-4000-8000-000000000004', 'hello@pixel.example',   'Pixel Labs',          'free',          100,    3000, 'active',    'trialing', 'stripe',   'email',    'none',     now(), now() - interval '18 days'),
  ('10000000-0000-4000-8000-000000000005', 'security@legacy.example','Legacy Financial',   'enterprise', 100000, 3000000, 'suspended', 'canceled', 'stripe',   'business', 'rejected', now(), now() - interval '2 years')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  tier = EXCLUDED.tier,
  daily_quota = EXCLUDED.daily_quota,
  monthly_quota = EXCLUDED.monthly_quota,
  status = EXCLUDED.status,
  billing_status = EXCLUDED.billing_status,
  billing_provider = EXCLUDED.billing_provider,
  kyc_level = EXCLUDED.kyc_level,
  kyc_status = EXCLUDED.kyc_status;

INSERT INTO subscriptions (
  id, customer_id, provider, provider_subscription_id, price_id, plan,
  status, current_period_start, current_period_end
) VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'stripe',   'sub_demo_acme',      'price_enterprise', 'enterprise', 'active',   now() - interval '12 days', now() + interval '18 days'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'cashfree', 'sub_demo_northstar', 'price_pro',        'pro',        'active',   now() - interval '12 days', now() + interval '18 days'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'paypal',   'sub_demo_orbit',     'price_pro',        'pro',        'past_due', now() - interval '12 days', now() + interval '18 days')
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, current_period_end = EXCLUDED.current_period_end;

INSERT INTO invoices (
  id, customer_id, provider_invoice_id, period_start, period_end,
  billed_quantity, metered_quantity, amount_cents, currency, status,
  drift, due_at, paid_at, tax_cents
) VALUES
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'inv_demo_acme_001',      current_date - 30, current_date, 180000, 178420, 249900, 'usd', 'paid',  -1580, now() - interval '3 days', now() - interval '8 days', 44982),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'inv_demo_northstar_001', current_date - 30, current_date,  42000,  43110,  79900, 'usd', 'open',   1110, now() + interval '5 days', null,                      14382),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'inv_demo_orbit_001',     current_date - 30, current_date,  19000,  19340,  49900, 'usd', 'open',    340, now() - interval '4 days', null,                       8982)
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, metered_quantity = EXCLUDED.metered_quantity, drift = EXCLUDED.drift;

INSERT INTO sending_domains (
  id, customer_id, domain, dkim_selector, dkim_public_key, dkim_private_key,
  verified_at, spf_verified, dkim_verified, dmarc_verified, dmarc_policy
) VALUES
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'mail.acme.example',      'mp1', 'demo-public-key', 'demo-private-key', now() - interval '1 year',  true, true, true,  'reject'),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'notify.northstar.example','mp1', 'demo-public-key', 'demo-private-key', now() - interval '6 months', true, true, true,  'quarantine'),
  ('40000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'email.orbit.example',     'mp1', 'demo-public-key', 'demo-private-key', now() - interval '4 months', true, true, false, 'none'),
  ('40000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', 'mail.pixel.example',       'mp1', 'demo-public-key', 'demo-private-key', null,                         false,false,false, null)
ON CONFLICT (customer_id, domain) DO UPDATE SET
  verified_at = EXCLUDED.verified_at,
  spf_verified = EXCLUDED.spf_verified,
  dkim_verified = EXCLUDED.dkim_verified,
  dmarc_verified = EXCLUDED.dmarc_verified,
  dmarc_policy = EXCLUDED.dmarc_policy;

INSERT INTO usage_daily (customer_id, usage_date, sent, delivered, bounced, complained)
SELECT c.customer_id, d::date,
       c.base + ((extract(day from d)::int * c.mult) % 900),
       round((c.base + ((extract(day from d)::int * c.mult) % 900)) * c.delivery)::int,
       round((c.base + ((extract(day from d)::int * c.mult) % 900)) * c.bounce)::int,
       CASE WHEN extract(day from d)::int % 3 = 0 THEN 1 ELSE 0 END
FROM (VALUES
  ('10000000-0000-4000-8000-000000000001'::uuid, 5200, 73, 0.982, 0.009),
  ('10000000-0000-4000-8000-000000000002'::uuid, 2100, 41, 0.966, 0.021),
  ('10000000-0000-4000-8000-000000000003'::uuid,  950, 29, 0.931, 0.048),
  ('10000000-0000-4000-8000-000000000004'::uuid,   42,  7, 0.950, 0.025)
) AS c(customer_id, base, mult, delivery, bounce)
CROSS JOIN generate_series(current_date - 29, current_date, interval '1 day') d
ON CONFLICT (customer_id, usage_date) DO UPDATE SET
  sent = EXCLUDED.sent,
  delivered = EXCLUDED.delivered,
  bounced = EXCLUDED.bounced,
  complained = EXCLUDED.complained;

INSERT INTO messages (
  message_id, customer_id, from_address, from_name, to_address, subject,
  text_body, tags, status, queued_at, accepted_at, delivered_at,
  bounced_at, opened_at, first_clicked_at, attempts, risk_score
)
SELECT
  'seed-admin-' || replace(c.customer_id::text, '-', '') || '-' || g,
  c.customer_id,
  c.sender,
  c.sender_name,
  'recipient' || g || '@example.net',
  CASE g % 4 WHEN 0 THEN 'Your weekly account summary' WHEN 1 THEN 'Payment receipt' WHEN 2 THEN 'Security notification' ELSE 'Welcome to our platform' END,
  'This is realistic local seed content for the admin console.',
  ARRAY['admin-demo', CASE WHEN g % 2 = 0 THEN 'transactional' ELSE 'notification' END],
  CASE
    WHEN g % 17 = 0 THEN 'hard_bounced'
    WHEN g % 13 = 0 THEN 'soft_bounced'
    WHEN g % 19 = 0 THEN 'failed'
    ELSE 'delivered'
  END,
  now() - (g || ' hours')::interval - (c.offset_days || ' days')::interval,
  now() - (g || ' hours')::interval - (c.offset_days || ' days')::interval + interval '3 seconds',
  CASE WHEN g % 17 <> 0 AND g % 13 <> 0 AND g % 19 <> 0 THEN now() - (g || ' hours')::interval - (c.offset_days || ' days')::interval + interval '8 seconds' END,
  CASE WHEN g % 17 = 0 OR g % 13 = 0 THEN now() - (g || ' hours')::interval - (c.offset_days || ' days')::interval + interval '9 seconds' END,
  CASE WHEN g % 3 = 0 THEN now() - (g || ' hours')::interval - (c.offset_days || ' days')::interval + interval '20 minutes' END,
  CASE WHEN g % 7 = 0 THEN now() - (g || ' hours')::interval - (c.offset_days || ' days')::interval + interval '25 minutes' END,
  1,
  CASE WHEN g % 19 = 0 THEN 58 ELSE 4 + (g % 12) END
FROM (VALUES
  ('10000000-0000-4000-8000-000000000001'::uuid, 'updates@mail.acme.example',       'Acme Commerce',   0),
  ('10000000-0000-4000-8000-000000000002'::uuid, 'alerts@notify.northstar.example','Northstar Health',0),
  ('10000000-0000-4000-8000-000000000003'::uuid, 'news@email.orbit.example',       'Orbit Education', 1),
  ('10000000-0000-4000-8000-000000000004'::uuid, 'hello@mail.pixel.example',       'Pixel Labs',      2)
) AS c(customer_id, sender, sender_name, offset_days)
CROSS JOIN generate_series(1, 36) g
WHERE NOT EXISTS (
  SELECT 1 FROM messages m
  WHERE m.message_id = 'seed-admin-' || replace(c.customer_id::text, '-', '') || '-' || g
);

-- Keep the fixed demo messages inside the dashboard's rolling windows when
-- this idempotent seed is rerun. Merely skipping existing IDs leaves all
-- message-based overview charts empty once the original fixture dates age out.
WITH refreshed AS (
  SELECT
    'seed-admin-' || replace(c.customer_id::text, '-', '') || '-' || g AS message_id,
    now() - (g || ' hours')::interval - (c.offset_days || ' days')::interval AS queued_at,
    g
  FROM (VALUES
    ('10000000-0000-4000-8000-000000000001'::uuid, 0),
    ('10000000-0000-4000-8000-000000000002'::uuid, 0),
    ('10000000-0000-4000-8000-000000000003'::uuid, 1),
    ('10000000-0000-4000-8000-000000000004'::uuid, 2)
  ) AS c(customer_id, offset_days)
  CROSS JOIN generate_series(1, 36) g
)
UPDATE messages m SET
  status = CASE
    WHEN r.g % 17 = 0 THEN 'hard_bounced'
    WHEN r.g % 13 = 0 THEN 'soft_bounced'
    WHEN r.g % 19 = 0 THEN 'failed'
    ELSE 'delivered'
  END,
  queued_at = r.queued_at,
  accepted_at = r.queued_at + interval '3 seconds',
  delivered_at = CASE WHEN r.g % 17 <> 0 AND r.g % 13 <> 0 AND r.g % 19 <> 0 THEN r.queued_at + interval '8 seconds' END,
  bounced_at = CASE WHEN r.g % 17 = 0 OR r.g % 13 = 0 THEN r.queued_at + interval '9 seconds' END,
  opened_at = CASE WHEN r.g % 3 = 0 THEN r.queued_at + interval '20 minutes' END,
  first_clicked_at = CASE WHEN r.g % 7 = 0 THEN r.queued_at + interval '25 minutes' END,
  attempts = 1,
  risk_score = CASE WHEN r.g % 19 = 0 THEN 58 ELSE 4 + (r.g % 12) END
FROM refreshed r
WHERE m.message_id = r.message_id;

INSERT INTO events (message_id, customer_id, event_type, payload, occurred_at, bot_verdict, bot_score, event_key)
SELECT m.message_id, m.customer_id, 'opened', '{"seed":true}'::jsonb,
       coalesce(m.opened_at, m.queued_at + interval '15 minutes'), 'human', 0.05,
       'seed-open-' || m.message_id
FROM messages m
WHERE m.message_id LIKE 'seed-admin-%' AND m.status = 'delivered'
  AND NOT EXISTS (SELECT 1 FROM events e WHERE e.event_key = 'seed-open-' || m.message_id);

INSERT INTO suppressions (customer_id, email, reason, notes, created_at) VALUES
  ('10000000-0000-4000-8000-000000000001', 'bounce1@example.net',    'hard_bounce', 'Mailbox does not exist', now() - interval '2 days'),
  ('10000000-0000-4000-8000-000000000002', 'complaint@example.net',  'complaint',   'ISP feedback loop',       now() - interval '4 days'),
  ('10000000-0000-4000-8000-000000000003', 'unsubscribe@example.net','unsubscribe', 'User preference',          now() - interval '1 day'),
  ('10000000-0000-4000-8000-000000000004', 'invalid@example.net',    'invalid',     'Invalid syntax',           now() - interval '8 hours')
ON CONFLICT (customer_id, email) DO UPDATE SET reason = EXCLUDED.reason, notes = EXCLUDED.notes;

INSERT INTO review_queue (id, message_id, customer_id, risk_score, reasons, status, created_at, reviewed_at) VALUES
  ('50000000-0000-4000-8000-000000000001', 'review-demo-001', '10000000-0000-4000-8000-000000000003', 82, ARRAY['phishing_language','suspicious_link'], 'pending',  now() - interval '3 hours', null),
  ('50000000-0000-4000-8000-000000000002', 'review-demo-002', '10000000-0000-4000-8000-000000000004', 67, ARRAY['new_account','high_recipient_count'], 'pending', now() - interval '75 minutes', null),
  ('50000000-0000-4000-8000-000000000003', 'review-demo-003', '10000000-0000-4000-8000-000000000002', 54, ARRAY['content_score'], 'approved', now() - interval '8 hours', now() - interval '7 hours'),
  ('50000000-0000-4000-8000-000000000004', 'review-demo-004', '10000000-0000-4000-8000-000000000005', 91, ARRAY['known_bad_domain','phishing_language'], 'rejected', now() - interval '6 hours', now() - interval '5 hours')
ON CONFLICT (id) DO UPDATE SET risk_score = EXCLUDED.risk_score, reasons = EXCLUDED.reasons, status = EXCLUDED.status;

INSERT INTO support_tickets (
  id, customer_id, subject, status, priority, category, last_message_at,
  ai_summary, ai_suggested_priority, ai_suggested_category, ai_confidence,
  ai_labels, ai_model, ai_triaged_at, first_response_due_at, resolution_due_at
) VALUES
  ('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'Delivery rate dropped after DNS change', 'open',    'urgent', 'deliverability', now() - interval '22 minutes', 'Customer reports a sharp delivery decline following SPF changes.', 'urgent', 'deliverability', 0.94, ARRAY['dns','spf','delivery'], 'demo-triage-v1', now() - interval '20 minutes', now() + interval '35 minutes', now() + interval '4 hours'),
  ('60000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003', 'Invoice shows unexpected overage',       'pending', 'high',   'billing',        now() - interval '3 hours',  'Customer is questioning metered overage on the current invoice.', 'high', 'billing', 0.89, ARRAY['invoice','usage'], 'demo-triage-v1', now() - interval '3 hours', now() - interval '2 hours', now() + interval '18 hours'),
  ('60000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004', 'How do I verify my sending domain?',     'open',    'normal', 'technical',      now() - interval '45 minutes', 'New customer needs DNS verification guidance.', 'normal', 'technical', 0.96, ARRAY['onboarding','dns'], 'demo-triage-v1', now() - interval '40 minutes', now() + interval '3 hours', now() + interval '24 hours'),
  ('60000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'Webhook retries resolved',              'resolved','low',    'technical',      now() - interval '2 days', 'Transient webhook failures were resolved after endpoint recovery.', 'low', 'technical', 0.91, ARRAY['webhook'], 'demo-triage-v1', now() - interval '2 days', now() - interval '3 days', now() - interval '2 days')
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, priority = EXCLUDED.priority, last_message_at = EXCLUDED.last_message_at;

INSERT INTO support_ticket_messages (id, ticket_id, author_type, body, internal, created_at) VALUES
  ('70000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'system', 'Customer: delivery fell from 98% to 71% after updating SPF yesterday.', false, now() - interval '25 minutes'),
  ('70000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000002', 'system', 'Customer: please explain the 1,110-message metering difference.', false, now() - interval '3 hours'),
  ('70000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000003', 'system', 'Customer: DNS records are added, but verification still shows pending.', false, now() - interval '45 minutes'),
  ('70000000-0000-4000-8000-000000000004', '60000000-0000-4000-8000-000000000004', 'system', 'Webhook endpoint recovered and queued deliveries were replayed.', false, now() - interval '2 days')
ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body;

INSERT INTO billing_events (provider_event_id, type, processed_at, provider, payload, replay_count) VALUES
  ('evt_demo_subscription_updated', 'customer.subscription.updated', now() - interval '2 hours', 'stripe',   '{"id":"evt_demo_subscription_updated","type":"customer.subscription.updated","data":{"object":{"id":"sub_demo_acme","status":"active"}}}', 0),
  ('evt_demo_payment_failed',       'invoice.payment_failed',         now() - interval '5 hours', 'stripe',   '{"id":"evt_demo_payment_failed","type":"invoice.payment_failed","data":{"object":{"id":"inv_demo_orbit_001"}}}', 0),
  ('evt_demo_cashfree_renewed',      'SUBSCRIPTION_PAYMENT_SUCCESS',   now() - interval '1 day',   'cashfree', '{"type":"SUBSCRIPTION_PAYMENT_SUCCESS","data":{"subscription_id":"sub_demo_northstar"}}', 0)
ON CONFLICT (provider_event_id) DO UPDATE SET processed_at = EXCLUDED.processed_at, payload = EXCLUDED.payload;

COMMIT;
