-- Store the metered subscription item id so usage can be reported to the
-- billing provider (Stripe). Populated when a subscription is created/updated.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS stripe_subscription_item_id TEXT;
