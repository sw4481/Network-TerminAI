-- src-tauri/migrations/V0050__iac_state_and_drift.sql
-- IaC Phase 3 — state browser cache + manual drift checks + drift exceptions.

CREATE TABLE terraform_state_cache (
  id             TEXT PRIMARY KEY,
  project_path   TEXT NOT NULL UNIQUE,
  state_json     TEXT NOT NULL,
  serial         INTEGER NOT NULL,
  resource_count INTEGER NOT NULL,
  last_updated   INTEGER NOT NULL
);

CREATE TABLE drift_checks (
  id                 TEXT PRIMARY KEY,
  project_path       TEXT NOT NULL,
  checked_at         INTEGER NOT NULL,
  has_drift          INTEGER NOT NULL,
  drifted_count      INTEGER NOT NULL DEFAULT 0,
  drift_summary_json TEXT,
  created_at         INTEGER NOT NULL
);

CREATE INDEX idx_drift_checks_project ON drift_checks(project_path, checked_at DESC);

CREATE TABLE drift_exceptions (
  id               TEXT PRIMARY KEY,
  project_path     TEXT NOT NULL,
  resource_address TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  UNIQUE(project_path, resource_address)
);
