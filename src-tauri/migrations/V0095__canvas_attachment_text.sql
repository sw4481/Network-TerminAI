ALTER TABLE canvas_attachments ADD COLUMN extracted_text TEXT;

-- No case FK: file cleanup authority must survive case/attachment deletion.
-- Imports reserve both generated names before writing, so interrupted staging
-- and failed publication can be reconciled at the next trusted initialization.
CREATE TABLE canvas_media_cleanup (
  storage_key TEXT PRIMARY KEY,
  case_id TEXT NOT NULL
);
