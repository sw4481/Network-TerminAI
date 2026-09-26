-- V0070: acknowledged per-line drift exceptions. A delta whose exact
-- normalized line matches an active exception for its template is suppressed.
CREATE TABLE IF NOT EXISTS intent_drift_exceptions (
  id           TEXT PRIMARY KEY,
  template_id  TEXT NOT NULL REFERENCES intent_templates(id) ON DELETE CASCADE,
  line         TEXT NOT NULL,
  note         TEXT,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_intent_drift_exceptions_template
  ON intent_drift_exceptions(template_id, line);
