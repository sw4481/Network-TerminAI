-- V0031 — Command palette index + usage tracking
--
-- Adds two structures that back the global Cmd+P fuzzy palette:
--   1. palette_usage   — recency + frequency for every pickable target
--   2. palette_index   — FTS5 over command + tags + vendor + platform for
--                        command_blocks rows
--
-- Requires V0028 (block_tags) to be applied first; the triggers and the
-- backfill SELECT join through block_tags.
--
-- We use an *ordinary* FTS5 virtual table here (no `content=`), not an
-- external-content one. The denormalised tag column is built by joining
-- block_tags, which external content cannot express. The trigger idiom
-- is therefore plain DELETE+INSERT (rather than the
-- `INSERT INTO fts(fts,...) VALUES('delete',...)` form used by V0014 for
-- the external-content `command_blocks_fts`).
--   https://sqlite.org/fts5.html#full_text_query_syntax

CREATE TABLE IF NOT EXISTS palette_usage (
  target_type TEXT NOT NULL,                 -- 'command'|'workflow'|'notebook'|'device'|'block'|'ssh'
  target_id   TEXT NOT NULL,                 -- free-form id per target type
  last_used_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  use_count   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_palette_usage_type_recent
  ON palette_usage(target_type, last_used_at DESC);
CREATE INDEX IF NOT EXISTS idx_palette_usage_type_count
  ON palette_usage(target_type, use_count DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS palette_index USING fts5(
  block_id UNINDEXED,
  tab_id   UNINDEXED,
  cmd,
  tags,
  vendor,
  platform,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- Insert: build a row for the new block. tags will be empty here and is
-- (re-)populated by the block_tags trigger when tags are added.
CREATE TRIGGER IF NOT EXISTS palette_index_block_ai
AFTER INSERT ON command_blocks BEGIN
  INSERT INTO palette_index(block_id, tab_id, cmd, tags, vendor, platform)
  VALUES (
    new.id,
    new.tab_id,
    new.cmd,
    COALESCE((SELECT group_concat(tag, ' ') FROM block_tags WHERE block_id = new.id), ''),
    '',
    ''
  );
END;

CREATE TRIGGER IF NOT EXISTS palette_index_block_au
AFTER UPDATE ON command_blocks BEGIN
  DELETE FROM palette_index WHERE block_id = old.id;
  INSERT INTO palette_index(block_id, tab_id, cmd, tags, vendor, platform)
  VALUES (
    new.id,
    new.tab_id,
    new.cmd,
    COALESCE((SELECT group_concat(tag, ' ') FROM block_tags WHERE block_id = new.id), ''),
    '',
    ''
  );
END;

CREATE TRIGGER IF NOT EXISTS palette_index_block_ad
AFTER DELETE ON command_blocks BEGIN
  DELETE FROM palette_index WHERE block_id = old.id;
END;

-- block_tags insert: re-aggregate the tag string for the parent block.
CREATE TRIGGER IF NOT EXISTS palette_index_tag_ai
AFTER INSERT ON block_tags BEGIN
  DELETE FROM palette_index WHERE block_id = new.block_id;
  INSERT INTO palette_index(block_id, tab_id, cmd, tags, vendor, platform)
    SELECT cb.id, cb.tab_id, cb.cmd,
           COALESCE((SELECT group_concat(tag, ' ') FROM block_tags WHERE block_id = cb.id), ''),
           '', ''
      FROM command_blocks cb WHERE cb.id = new.block_id;
END;

CREATE TRIGGER IF NOT EXISTS palette_index_tag_ad
AFTER DELETE ON block_tags BEGIN
  DELETE FROM palette_index WHERE block_id = old.block_id;
  INSERT INTO palette_index(block_id, tab_id, cmd, tags, vendor, platform)
    SELECT cb.id, cb.tab_id, cb.cmd,
           COALESCE((SELECT group_concat(tag, ' ') FROM block_tags WHERE block_id = cb.id), ''),
           '', ''
      FROM command_blocks cb WHERE cb.id = old.block_id;
END;

-- Backfill from existing blocks.
INSERT INTO palette_index(block_id, tab_id, cmd, tags, vendor, platform)
SELECT cb.id, cb.tab_id, cb.cmd,
       COALESCE((SELECT group_concat(tag, ' ') FROM block_tags WHERE block_id = cb.id), ''),
       '', ''
FROM command_blocks cb;
