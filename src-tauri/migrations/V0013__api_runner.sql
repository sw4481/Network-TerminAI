-- Phase 2+ API Runner: new tab type + supporting tables.
-- tab_type discriminates PTY-backed terminal tabs from API Runner tabs.
-- Backfills all pre-existing rows to 'terminal'.
ALTER TABLE tabs ADD COLUMN tab_type TEXT NOT NULL DEFAULT 'terminal';

CREATE TABLE IF NOT EXISTS api_tab_state (
  tab_id      TEXT    PRIMARY KEY REFERENCES tabs(id) ON DELETE CASCADE,
  target_id   TEXT,
  environment TEXT,
  endpoint_id TEXT,
  raw_mode    INTEGER NOT NULL DEFAULT 0,
  scratch_request_json TEXT
);

CREATE TABLE IF NOT EXISTS api_saved_requests (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  target_id   TEXT,
  environment TEXT,
  method      TEXT    NOT NULL,
  url         TEXT    NOT NULL,
  headers_json TEXT   NOT NULL DEFAULT '{}',
  query_json   TEXT   NOT NULL DEFAULT '{}',
  body_text    TEXT,
  body_kind    TEXT   NOT NULL DEFAULT 'none',
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS api_history (
  id               TEXT    PRIMARY KEY,
  tab_id           TEXT    REFERENCES tabs(id) ON DELETE SET NULL,
  saved_request_id TEXT    REFERENCES api_saved_requests(id) ON DELETE SET NULL,
  target_id        TEXT,
  environment      TEXT,
  method           TEXT    NOT NULL,
  url              TEXT    NOT NULL,
  request_headers_json TEXT NOT NULL,
  request_body     BLOB,
  status_code      INTEGER,
  response_headers_json TEXT,
  response_body    BLOB,
  response_body_truncated INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER,
  error            TEXT,
  sent_at          INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_api_history_tab   ON api_history(tab_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_history_saved ON api_history(saved_request_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS api_env_vars (
  environment TEXT    NOT NULL,
  key         TEXT    NOT NULL,
  value       TEXT    NOT NULL,
  is_secret   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (environment, key)
);
