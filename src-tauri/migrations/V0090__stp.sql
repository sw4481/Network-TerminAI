CREATE TABLE IF NOT EXISTS stp_settings (
    singleton_id TEXT PRIMARY KEY CHECK (singleton_id = 'stp'),
    schedule_enabled INTEGER NOT NULL DEFAULT 0 CHECK (schedule_enabled IN (0, 1)),
    interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (interval_minutes IN (30, 60, 240)),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT OR IGNORE INTO stp_settings (singleton_id) VALUES ('stp');

CREATE TABLE IF NOT EXISTS stp_snapshots (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
    status TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'failed')),
    baseline_eligible INTEGER NOT NULL DEFAULT 0 CHECK (baseline_eligible IN (0, 1)),
    schema_version INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    error_summary TEXT,
    CHECK (baseline_eligible = 0 OR status = 'complete')
);
CREATE INDEX IF NOT EXISTS idx_stp_snapshots_started_at ON stp_snapshots(started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS stp_schedule_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
    outcome TEXT NOT NULL,
    reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stp_schedule_events_occurred_at ON stp_schedule_events(occurred_at DESC, id DESC);
