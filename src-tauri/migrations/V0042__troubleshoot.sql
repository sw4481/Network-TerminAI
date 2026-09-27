-- Plan 15 Phase 1 — AI-Driven Troubleshooting Tree
--
-- Three tables back the playbook authoring + run-history surface:
--
--   troubleshoot_playbooks  — YAML-authored decision trees. `builtin=1` rows
--                             are seeded from the bundled corpus and are
--                             read-only from the user's perspective: the
--                             Tauri `delete_playbook` command refuses them
--                             and the seed loader UPSERTs only when
--                             `builtin=1` so user-forked copies (id reused
--                             with builtin=0) are never trampled.
--
--   troubleshoot_runs       — One row per attempt to walk a playbook against
--                             a tab. `status` is constrained to the four
--                             lifecycle states the engine emits. `conclusion_json`
--                             is populated by Phase 3's narrator on terminal
--                             status (Completed / Failed).
--
--   troubleshoot_steps      — Per-step result trail. `idx` is the linear
--                             execution order so the UI can replay deterministically;
--                             `parent_idx` records the branching parent for
--                             tree visualisation. The composite PK
--                             (run_id, idx) keeps a single rusqlite
--                             upsert path.

CREATE TABLE IF NOT EXISTS troubleshoot_playbooks (
  id TEXT PRIMARY KEY,                -- slug, e.g. 'bgp-wont-peer'
  name TEXT NOT NULL,
  symptom_keywords TEXT NOT NULL,     -- JSON array of strings
  vendor TEXT NOT NULL,               -- 'cisco' | 'juniper' | 'arista' | '*'
  platform TEXT NOT NULL,             -- 'iosxe' | 'nxos' | 'junos' | 'eos' | '*'
  body_yaml TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_tb_playbooks_vendor ON troubleshoot_playbooks(vendor, platform);

CREATE TABLE IF NOT EXISTS troubleshoot_runs (
  id TEXT PRIMARY KEY,                -- uuid
  playbook_id TEXT NOT NULL REFERENCES troubleshoot_playbooks(id) ON DELETE RESTRICT,
  tab_id TEXT NOT NULL,
  symptom TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','paused','completed','failed')),
  started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  ended_at INTEGER,
  conclusion_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_tb_runs_tab ON troubleshoot_runs(tab_id, started_at DESC);

CREATE TABLE IF NOT EXISTS troubleshoot_steps (
  run_id TEXT NOT NULL REFERENCES troubleshoot_runs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  step_type TEXT NOT NULL CHECK (step_type IN ('command','assertion','branch','narration','user_prompt')),
  step_ref TEXT NOT NULL,             -- YAML step id or inline label
  status TEXT NOT NULL CHECK (status IN ('pending','running','passed','failed','skipped','awaiting_user')),
  result_json TEXT,
  parent_idx INTEGER,
  started_at INTEGER,
  ended_at INTEGER,
  PRIMARY KEY (run_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_tb_steps_parent ON troubleshoot_steps(run_id, parent_idx);
