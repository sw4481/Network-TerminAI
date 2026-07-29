-- Phase 0 placeholder migration. Phase 1 will add real tables.
CREATE TABLE IF NOT EXISTS schema_placeholder (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
