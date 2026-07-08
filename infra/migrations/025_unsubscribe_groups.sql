-- Unsubscribe groups: named lists that let recipients opt out of specific
-- categories (newsletters, product updates, promotions) without hitting the
-- global suppression list. Senders can include a group_id on each send so
-- the unsubscribe link only suppresses that group, not all mail.

CREATE TABLE IF NOT EXISTS unsubscribe_groups (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name        text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text        CHECK (char_length(description) <= 500),
  is_default  boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unsubscribe_groups_pkey PRIMARY KEY (id)
);

-- Each customer can have at most one default group.
CREATE UNIQUE INDEX IF NOT EXISTS unsubscribe_groups_default_uniq
  ON unsubscribe_groups (customer_id)
  WHERE is_default = true;

CREATE INDEX IF NOT EXISTS unsubscribe_groups_customer_idx
  ON unsubscribe_groups (customer_id);

-- Per-group suppression records.
CREATE TABLE IF NOT EXISTS unsubscribe_group_members (
  id            bigserial,
  group_id      uuid        NOT NULL REFERENCES unsubscribe_groups(id) ON DELETE CASCADE,
  customer_id   uuid        NOT NULL,
  email         text        NOT NULL,
  unsubscribed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unsubscribe_group_members_pkey PRIMARY KEY (id),
  CONSTRAINT unsubscribe_group_members_uniq UNIQUE (group_id, email)
);

CREATE INDEX IF NOT EXISTS ugm_customer_email_idx
  ON unsubscribe_group_members (customer_id, email);
