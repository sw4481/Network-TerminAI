-- V0048 — distinguish synthetic command_blocks from real shell blocks.
--
-- The SSH-direct structured-parse path (parse_and_store_adhoc) creates a
-- command_blocks row purely to satisfy the parsed_outputs.block_id foreign
-- key. Those rows are NOT something the user typed into the shell, so they
-- must not appear in the tab's block list / scrollback.
--
-- `block_source` defaults to 'shell' so every existing row (and every block
-- created by the normal OSC-133 pipeline) keeps showing up unchanged.
-- list_blocks() filters to 'shell' only.
ALTER TABLE command_blocks ADD COLUMN block_source TEXT NOT NULL DEFAULT 'shell';

CREATE INDEX IF NOT EXISTS idx_command_blocks_source
  ON command_blocks(tab_id, block_source);
