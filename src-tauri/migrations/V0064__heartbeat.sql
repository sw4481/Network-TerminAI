-- V0063: Heartbeat monitoring system (scheduled health checks)

CREATE TABLE heartbeats (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  interval_minutes  INTEGER NOT NULL CHECK (interval_minutes > 0),
  retention_days    INTEGER NOT NULL DEFAULT 30 CHECK (retention_days >= 1),
  enabled           INTEGER NOT NULL DEFAULT 1,
  next_run_at       INTEGER,
  created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_heartbeats_enabled ON heartbeats(enabled) WHERE enabled = 1;
CREATE INDEX idx_heartbeats_next_run ON heartbeats(next_run_at) WHERE enabled = 1;

CREATE TABLE heartbeat_checks (
  id              TEXT PRIMARY KEY,
  heartbeat_id    TEXT NOT NULL REFERENCES heartbeats(id) ON DELETE CASCADE,
  check_group_name TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  agent_prompt    TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_heartbeat_checks_heartbeat ON heartbeat_checks(heartbeat_id, sort_order);

CREATE TABLE heartbeat_executions (
  id                TEXT PRIMARY KEY,
  heartbeat_id      TEXT NOT NULL REFERENCES heartbeats(id) ON DELETE CASCADE,
  status            TEXT NOT NULL CHECK (status IN ('running','completed','completed_with_errors','failed')),
  started_at        INTEGER NOT NULL,
  completed_at      INTEGER,
  duration_ms       INTEGER,
  overall_severity  TEXT NOT NULL DEFAULT 'info' CHECK (overall_severity IN ('ok','info','warning','critical','error'))
);

CREATE INDEX idx_heartbeat_executions_heartbeat_time ON heartbeat_executions(heartbeat_id, started_at DESC);
CREATE INDEX idx_heartbeat_executions_status ON heartbeat_executions(status);

CREATE TABLE heartbeat_findings (
  id              TEXT PRIMARY KEY,
  execution_id    TEXT NOT NULL REFERENCES heartbeat_executions(id) ON DELETE CASCADE,
  check_id        TEXT NOT NULL REFERENCES heartbeat_checks(id) ON DELETE CASCADE,
  severity        TEXT NOT NULL CHECK (severity IN ('ok','info','warning','critical','error')),
  title           TEXT NOT NULL,
  message         TEXT NOT NULL DEFAULT '',
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_heartbeat_findings_execution ON heartbeat_findings(execution_id);
CREATE INDEX idx_heartbeat_findings_severity ON heartbeat_findings(severity);

CREATE TABLE heartbeat_suggestions (
  id                    TEXT PRIMARY KEY,
  heartbeat_id          TEXT NOT NULL REFERENCES heartbeats(id) ON DELETE CASCADE,
  suggestion_type       TEXT NOT NULL CHECK (suggestion_type IN ('add_checks','remove_checks','modify_checks')),
  description           TEXT NOT NULL,
  proposed_checks_json  TEXT NOT NULL,
  created_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  dismissed_at          INTEGER
);

CREATE INDEX idx_heartbeat_suggestions_heartbeat ON heartbeat_suggestions(heartbeat_id, dismissed_at);
