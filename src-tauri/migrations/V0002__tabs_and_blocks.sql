-- Tabs persisted across app restarts.
CREATE TABLE IF NOT EXISTS tabs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  shell_cmd TEXT NOT NULL,
  cwd TEXT NOT NULL,
  -- profile_id reserved for Phase 2 (AI profiles); NULL in Phase 1.
  profile_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  closed_at INTEGER
);

-- One row per command/output pair identified by OSC 133.
CREATE TABLE IF NOT EXISTS command_blocks (
  id TEXT PRIMARY KEY,
  tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  cmd TEXT NOT NULL,
  output BLOB NOT NULL,
  exit_code INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_blocks_tab ON command_blocks(tab_id, started_at);

-- Raw scrollback ring buffer per tab (bounded).
-- Phase 1 stores bytes rather than UTF-8 to survive binary output from tools like `curl | gzip`.
CREATE TABLE IF NOT EXISTS scrollback (
  tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  chunk BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (tab_id, seq)
);
