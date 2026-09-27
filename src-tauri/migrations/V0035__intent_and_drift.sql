-- V0035: Configuration intent + drift detection (Plan 08).

CREATE TABLE IF NOT EXISTS intent_templates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  vendor          TEXT NOT NULL,
  platform        TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('golden','jinja')),
  body            TEXT NOT NULL,
  vars_yaml       TEXT NOT NULL DEFAULT '',
  selector_json   TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_intent_templates_vendor_platform
  ON intent_templates(vendor, platform);
CREATE INDEX IF NOT EXISTS idx_intent_templates_name
  ON intent_templates(name);

CREATE TABLE IF NOT EXISTS intent_assignments (
  template_id        TEXT NOT NULL REFERENCES intent_templates(id) ON DELETE CASCADE,
  device_id          TEXT NOT NULL,
  device_kind        TEXT NOT NULL,
  override_vars_yaml TEXT NOT NULL DEFAULT '',
  created_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (template_id, device_id, device_kind)
);
CREATE INDEX IF NOT EXISTS idx_intent_assignments_device
  ON intent_assignments(device_id, device_kind);

CREATE TABLE IF NOT EXISTS drift_reports (
  id            TEXT PRIMARY KEY,
  template_id   TEXT NOT NULL REFERENCES intent_templates(id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL,
  device_kind   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('in_sync','drift','error')),
  severity      TEXT NOT NULL DEFAULT 'none' CHECK (severity IN ('none','additive','destructive','error')),
  diff_patch    TEXT NOT NULL DEFAULT '',
  error_msg     TEXT,
  captured_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_drift_reports_template_time
  ON drift_reports(template_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_drift_reports_device_time
  ON drift_reports(device_id, device_kind, captured_at DESC);

CREATE TABLE IF NOT EXISTS drift_schedules (
  id            TEXT PRIMARY KEY,
  template_id   TEXT NOT NULL REFERENCES intent_templates(id) ON DELETE CASCADE,
  cron_expr     TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_run_at   INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_drift_schedules_enabled
  ON drift_schedules(enabled) WHERE enabled = 1;
