CREATE TABLE IF NOT EXISTS block_tags (
  block_id TEXT NOT NULL REFERENCES command_blocks(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (block_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_block_tags_tag ON block_tags(tag);

CREATE TABLE IF NOT EXISTS block_pins (
  block_id TEXT PRIMARY KEY REFERENCES command_blocks(id) ON DELETE CASCADE,
  pinned_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS block_shares (
  share_id TEXT PRIMARY KEY,                 -- uuidv4
  block_id TEXT REFERENCES command_blocks(id) ON DELETE SET NULL,
  payload_json TEXT NOT NULL,                -- snapshot so share survives block deletion
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Persist collapse state server-side (today it is UI-only and forgotten on reload).
ALTER TABLE command_blocks ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0;
