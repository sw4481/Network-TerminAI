-- Topolograph configuration and metadata-only audit boundary.
CREATE TABLE IF NOT EXISTS topolograph_config (
    singleton_id TEXT PRIMARY KEY CHECK (singleton_id = 'topolograph'),
    enabled     INTEGER NOT NULL DEFAULT 0,
    base_url    TEXT NOT NULL DEFAULT '',
    secret_id   TEXT NOT NULL DEFAULT '',
    verify_tls  INTEGER NOT NULL DEFAULT 1,
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS topolograph_audit (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    caller_kind  TEXT NOT NULL DEFAULT '',
    caller_id    TEXT NOT NULL DEFAULT '',
    action       TEXT NOT NULL DEFAULT '',
    target_label TEXT NOT NULL DEFAULT '',
    outcome      TEXT NOT NULL DEFAULT '',
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    error_code   TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_topolograph_audit_occurred_at
    ON topolograph_audit(occurred_at DESC);
