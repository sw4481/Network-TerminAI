-- V0030: Runnable Notebooks (MOPs).
-- Plan: /Plans/03-notebooks-runnable-mops.md
--
-- Distinct from V0021 `block_notebooks` (those are "snapshots of executed
-- blocks" -- presentational artefacts). These tables hold executable recipes
-- with a typed cell graph and a per-run audit trail.

CREATE TABLE IF NOT EXISTS notebooks (
  id TEXT PRIMARY KEY,                       -- 'nb-<uuidv4>'
  title TEXT NOT NULL,
  description TEXT,
  vendor TEXT,                               -- 'cisco' | 'juniper' | 'arista' | NULL (multi)
  platform TEXT,                             -- 'iosxe' | 'nxos' | 'junos' | NULL
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  body_markdown TEXT NOT NULL,               -- verbatim markdown for byte-stable export
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_notebooks_vendor ON notebooks(vendor);

CREATE TABLE IF NOT EXISTS notebook_cells (
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  cell_type TEXT NOT NULL CHECK (cell_type IN ('markdown','command','approval','assertion','parameter')),
  content TEXT NOT NULL,                     -- raw cell body (markdown / command / JSONPath expr / etc.)
  metadata_json TEXT NOT NULL DEFAULT '{}',  -- per-cell-type config (see parser)
  PRIMARY KEY (notebook_id, idx)
);

CREATE TABLE IF NOT EXISTS notebook_runs (
  id TEXT PRIMARY KEY,                       -- 'run-<uuidv4>'
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  tab_id TEXT NOT NULL,                      -- which PTY tab owns this run
  status TEXT NOT NULL CHECK (status IN ('running','paused','completed','failed','cancelled')),
  params_json TEXT NOT NULL DEFAULT '{}',    -- user-supplied {{var}} values
  started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notebook_runs_notebook ON notebook_runs(notebook_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_notebook_runs_status  ON notebook_runs(status);

CREATE TABLE IF NOT EXISTS notebook_cell_runs (
  run_id TEXT NOT NULL REFERENCES notebook_runs(id) ON DELETE CASCADE,
  cell_idx INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','passed','failed','skipped','awaiting_approval')),
  block_id TEXT,                             -- FK to command_blocks when cell_type='command' or 'assertion'
  error TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  PRIMARY KEY (run_id, cell_idx)
);
CREATE INDEX IF NOT EXISTS idx_notebook_cell_runs_status ON notebook_cell_runs(run_id, status);
