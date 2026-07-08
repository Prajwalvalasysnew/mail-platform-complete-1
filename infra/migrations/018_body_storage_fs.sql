-- Allow the filesystem body-storage backend (zero-dependency single-node option)
-- in addition to inline and s3-compatible object storage.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_body_storage_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_storage_check
  CHECK (body_storage IN ('inline', 'fs', 's3'));
