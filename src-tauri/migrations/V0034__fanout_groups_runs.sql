-- V0034: Multi-device fan-out groups and runs (Plan 07).
-- attempt_number folded in from the start so retry attempts share a run_id.

CREATE TABLE IF NOT EXISTS fanout_groups (
  id          TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name        TEXT    NOT NULL UNIQUE,
  description TEXT,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_fanout_groups_name ON fanout_groups(name);

CREATE TABLE IF NOT EXISTS fanout_group_members (
  group_id    TEXT    NOT NULL REFERENCES fanout_groups(id) ON DELETE CASCADE,
  device_id   TEXT    NOT NULL,
  device_kind TEXT    NOT NULL CHECK (device_kind IN ('ssh','netconf')),
  added_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (group_id, device_id, device_kind)
);
CREATE INDEX IF NOT EXISTS idx_fanout_members_device
  ON fanout_group_members(device_kind, device_id);

CREATE TABLE IF NOT EXISTS fanout_runs (
  id          TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  group_id    TEXT    REFERENCES fanout_groups(id) ON DELETE SET NULL,
  command     TEXT    NOT NULL,
  started_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  ended_at    INTEGER,
  status      TEXT    NOT NULL CHECK (status IN
                ('pending','running','success','partial','failed','cancelled')),
  params_json TEXT    NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_fanout_runs_started ON fanout_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_fanout_runs_group   ON fanout_runs(group_id, started_at DESC);

-- attempt_number permits retries: each retry inserts a fresh row sharing the
-- (run_id, device_id, device_kind) prefix but bumping attempt_number.
CREATE TABLE IF NOT EXISTS fanout_run_results (
  run_id            TEXT    NOT NULL REFERENCES fanout_runs(id) ON DELETE CASCADE,
  device_id         TEXT    NOT NULL,
  device_kind       TEXT    NOT NULL CHECK (device_kind IN ('ssh','netconf')),
  attempt_number    INTEGER NOT NULL DEFAULT 1,
  block_id          TEXT,
  parsed_output_id  TEXT,
  status            TEXT    NOT NULL CHECK (status IN
                      ('pending','running','success','failed','timeout','cancelled')),
  error             TEXT,
  started_at        INTEGER,
  ended_at          INTEGER,
  PRIMARY KEY (run_id, device_id, device_kind, attempt_number)
);
CREATE INDEX IF NOT EXISTS idx_fanout_results_status
  ON fanout_run_results(run_id, status);
