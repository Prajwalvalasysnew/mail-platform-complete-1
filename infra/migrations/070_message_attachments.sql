-- Attachment support on /v1/send (invoices, payroll slips, lab reports).
--
-- The column stores an array of attachment descriptors:
--   [{ "filename", "content_type", "size", "content_b64"? }]
-- content_b64 is present ONLY when BODY_STORAGE=inline (dev/test); with the
-- fs/s3 body stores the attachment content is serialized into the same
-- content-addressed body object as html/text (shared across recipients and
-- covered by the existing GDPR body-erasure flow), and the column carries
-- metadata only so message-detail reads never touch the object store.

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS attachments JSONB;
