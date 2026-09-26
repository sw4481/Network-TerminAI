-- Code Editor tab support: file state, recent files, sessions.
-- No schema change to `tabs`: the existing `tab_type TEXT` column
-- accepts 'editor' without modification.

CREATE TABLE IF NOT EXISTS editor_tab_state (
  tab_id          TEXT    PRIMARY KEY REFERENCES tabs(id) ON DELETE CASCADE,
  file_path       TEXT,   -- Null for new untitled files
  language        TEXT    NOT NULL DEFAULT 'plaintext',
  cursor_line     INTEGER NOT NULL DEFAULT 0,
  cursor_column   INTEGER NOT NULL DEFAULT 0,
  scroll_position REAL    NOT NULL DEFAULT 0.0,
  is_dirty        INTEGER NOT NULL DEFAULT 0,
  content_cache   TEXT,   -- Optional: cache content for faster restore
  updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS editor_recent_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path     TEXT    NOT NULL UNIQUE,
  last_opened   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  language      TEXT,
  line_count    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_editor_recent_opened
  ON editor_recent_files(last_opened DESC);

-- Optional: Session snapshots for editor state
CREATE TABLE IF NOT EXISTS editor_sessions (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  description TEXT,
  tabs_json   TEXT    NOT NULL, -- JSON array of editor states
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
