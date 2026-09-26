CREATE TABLE IF NOT EXISTS parsers_cache (
  key TEXT PRIMARY KEY,              -- sha256(vendor|platform|command|raw)
  vendor TEXT NOT NULL,
  platform TEXT NOT NULL,
  command TEXT NOT NULL,
  parser TEXT NOT NULL,              -- 'genie' | 'textfsm'
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_parsers_cache_created ON parsers_cache(created_at DESC);

CREATE TABLE IF NOT EXISTS sidecar_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_seen INTEGER,
  version TEXT,
  pid INTEGER
);
INSERT OR IGNORE INTO sidecar_status (id) VALUES (1);
