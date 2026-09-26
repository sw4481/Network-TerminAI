-- V0047__iac_executions.sql
-- Track IaC executions with structured metadata

CREATE TABLE iac_executions (
  id TEXT PRIMARY KEY,
  command_block_id TEXT NOT NULL REFERENCES command_blocks(id) ON DELETE CASCADE,
  tool TEXT NOT NULL CHECK(tool IN ('terraform', 'ansible')),
  subcommand TEXT NOT NULL,
  project_path TEXT NOT NULL,
  git_commit TEXT,
  git_branch TEXT,
  had_uncommitted_changes INTEGER NOT NULL DEFAULT 0,
  blast_radius TEXT CHECK(blast_radius IN ('low', 'medium', 'high', 'critical')),
  resources_changed INTEGER,
  resources_failed INTEGER,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_iac_executions_tool ON iac_executions(tool, created_at DESC);
CREATE INDEX idx_iac_executions_project ON iac_executions(project_path, created_at DESC);
CREATE INDEX idx_iac_executions_block ON iac_executions(command_block_id);
