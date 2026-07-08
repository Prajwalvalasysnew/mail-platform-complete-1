-- Link messages to an unsubscribe group so the tracker can add group-scoped
-- unsubscribes (RFC 8058 one-click) instead of always doing a global suppression.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS unsubscribe_group_id uuid
    REFERENCES unsubscribe_groups(id) ON DELETE SET NULL;
