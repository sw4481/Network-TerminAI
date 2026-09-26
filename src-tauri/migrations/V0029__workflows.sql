-- V0029: Workflows / Parameterized Commands
-- Plan: /Plans/02-workflows-parameterized.md

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,                       -- uuidv4
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  vendor TEXT NOT NULL CHECK (vendor IN ('cisco','juniper','arista','meraki','generic')),
  platform TEXT NOT NULL DEFAULT '',         -- e.g. 'iosxe','nxos','junos','eos','dashboard','generic'
  tags TEXT NOT NULL DEFAULT '[]',           -- JSON array of strings
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_workflows_vendor_platform ON workflows(vendor, platform);
CREATE INDEX IF NOT EXISTS idx_workflows_name ON workflows(name);

CREATE TABLE IF NOT EXISTS workflow_steps (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,                      -- 0-based order
  command_template TEXT NOT NULL,            -- e.g. "show interface {{ intf }} counters"
  PRIMARY KEY (workflow_id, idx)
);

CREATE TABLE IF NOT EXISTS workflow_params (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                        -- placeholder key, no braces
  type TEXT NOT NULL CHECK (type IN ('string','enum','ip','int','interface')),
  default_value TEXT,                        -- nullable
  required INTEGER NOT NULL DEFAULT 1,       -- 0/1
  description TEXT NOT NULL DEFAULT '',
  enum_values TEXT,                          -- JSON array when type='enum', else NULL
  PRIMARY KEY (workflow_id, name)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,                       -- uuidv4 (also used as block_group_id)
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  tab_id TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',    -- {name: value}
  started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_tab ON workflow_runs(tab_id, started_at DESC);

-- Link command_blocks to a workflow_run so the UI can render "block groups".
-- Non-destructive: existing blocks have block_group_id = NULL.
ALTER TABLE command_blocks ADD COLUMN block_group_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_command_blocks_group ON command_blocks(block_group_id);
