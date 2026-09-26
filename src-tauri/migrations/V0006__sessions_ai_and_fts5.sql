-- Combined Phase 6 migration: Sessions, AI messages, and FTS5 search

-- AI chat messages per tab
CREATE TABLE IF NOT EXISTS ai_messages (
  id TEXT PRIMARY KEY,
  tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,  -- Application-provided timestamp for message ordering
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_tab ON ai_messages(tab_id, timestamp);

-- Saved sessions for session persistence
CREATE TABLE IF NOT EXISTS saved_sessions (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  tab_snapshot_json TEXT NOT NULL,  -- JSON array of tabs
  active_tab_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS session_scrollback (
  session_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  scrollback BLOB NOT NULL,
  PRIMARY KEY (session_id, tab_id),
  FOREIGN KEY (session_id) REFERENCES saved_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_ai_history (
  session_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  PRIMARY KEY (session_id, tab_id),
  FOREIGN KEY (session_id) REFERENCES saved_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_saved_sessions_created ON saved_sessions(created_at DESC);

-- Session snapshots for auto-restore on launch
-- "__last__" snapshot is automatically saved on exit
CREATE TABLE IF NOT EXISTS session_snapshots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,  -- "__last__" for auto-save on exit
  active_tab_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Session tabs - links tabs to snapshots
CREATE TABLE IF NOT EXISTS session_snapshot_tabs (
  snapshot_id TEXT NOT NULL REFERENCES session_snapshots(id) ON DELETE CASCADE,
  tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  tab_order INTEGER NOT NULL,  -- preserve tab order
  PRIMARY KEY (snapshot_id, tab_id)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_tabs ON session_snapshot_tabs(snapshot_id, tab_order);

-- FTS5 virtual tables for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS command_blocks_fts USING fts5(
  cmd, output, content='command_blocks', content_rowid='rowid'
);

CREATE VIRTUAL TABLE IF NOT EXISTS ai_messages_fts USING fts5(
  content, content='ai_messages', content_rowid='rowid'
);

CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  name, description, when_to_use, playbook, content='skills', content_rowid='rowid'
);

-- Triggers to keep command_blocks_fts in sync
CREATE TRIGGER IF NOT EXISTS command_blocks_ai AFTER INSERT ON command_blocks BEGIN
  INSERT INTO command_blocks_fts(rowid, cmd, output)
  VALUES (new.rowid, new.cmd, new.output);
END;

CREATE TRIGGER IF NOT EXISTS command_blocks_au AFTER UPDATE ON command_blocks BEGIN
  UPDATE command_blocks_fts SET cmd = new.cmd, output = new.output
  WHERE rowid = new.rowid;
END;

CREATE TRIGGER IF NOT EXISTS command_blocks_ad AFTER DELETE ON command_blocks BEGIN
  DELETE FROM command_blocks_fts WHERE rowid = old.rowid;
END;

-- Triggers to keep ai_messages_fts in sync
CREATE TRIGGER IF NOT EXISTS ai_messages_ai AFTER INSERT ON ai_messages BEGIN
  INSERT INTO ai_messages_fts(rowid, content)
  VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS ai_messages_au AFTER UPDATE ON ai_messages BEGIN
  UPDATE ai_messages_fts SET content = new.content
  WHERE rowid = new.rowid;
END;

CREATE TRIGGER IF NOT EXISTS ai_messages_ad AFTER DELETE ON ai_messages BEGIN
  DELETE FROM ai_messages_fts WHERE rowid = old.rowid;
END;

-- Triggers to keep skills_fts in sync
CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(rowid, name, description, when_to_use, playbook)
  VALUES (new.rowid, new.name, new.description, new.when_to_use, new.playbook);
END;

CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills BEGIN
  UPDATE skills_fts SET
    name = new.name,
    description = new.description,
    when_to_use = new.when_to_use,
    playbook = new.playbook
  WHERE rowid = new.rowid;
END;

CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
  DELETE FROM skills_fts WHERE rowid = old.rowid;
END;
