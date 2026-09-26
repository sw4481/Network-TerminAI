-- Block Notebooks: Save/load terminal sessions
CREATE TABLE IF NOT EXISTS block_notebooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  blocks_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notebooks_created ON block_notebooks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notebooks_name ON block_notebooks(name);
