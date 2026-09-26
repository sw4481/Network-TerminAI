-- V0032 — Structured show-output layer (Plan 05)
--
-- Three new tables backing the "Structured" tab inside CommandBlock:
--   1. parsed_outputs   — one parsed dataframe per block (UNIQUE on block_id)
--   2. parsed_snapshots — user-named pins of a parsed_outputs row
--   3. parse_schemas    — optional learned alignment hints used by diff_snapshots

CREATE TABLE IF NOT EXISTS parsed_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id TEXT NOT NULL UNIQUE REFERENCES command_blocks(id) ON DELETE CASCADE,
  parser TEXT NOT NULL,                 -- 'genie' | 'textfsm'
  command TEXT NOT NULL,
  vendor TEXT NOT NULL,
  platform TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_parsed_outputs_command ON parsed_outputs(command);
CREATE INDEX IF NOT EXISTS idx_parsed_outputs_vendor_platform ON parsed_outputs(vendor, platform);

CREATE TABLE IF NOT EXISTS parsed_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tab_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parsed_output_id INTEGER NOT NULL REFERENCES parsed_outputs(id) ON DELETE CASCADE,
  captured_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_parsed_snapshots_tab ON parsed_snapshots(tab_id);
CREATE INDEX IF NOT EXISTS idx_parsed_snapshots_name ON parsed_snapshots(name);

CREATE TABLE IF NOT EXISTS parse_schemas (
  parser TEXT NOT NULL,
  command TEXT NOT NULL,
  vendor TEXT NOT NULL,
  platform TEXT NOT NULL,
  schema_json TEXT NOT NULL,            -- { "key": "interface", "columns": [...] }
  learned_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (parser, command, vendor, platform)
);
