-- An erasure request may use the same opaque identifier in two stores.
-- Store kind is therefore part of the durable work-item identity.
ALTER TABLE deletion_object_items
  DROP CONSTRAINT IF EXISTS deletion_object_items_deletion_request_id_object_key_key;

ALTER TABLE deletion_object_items
  ADD CONSTRAINT deletion_object_items_request_store_key_unique
  UNIQUE (deletion_request_id, storage_kind, object_key);
