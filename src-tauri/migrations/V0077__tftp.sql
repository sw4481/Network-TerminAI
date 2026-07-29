-- TFTP server config (singleton row). TFTP has no users/passive ports.
CREATE TABLE IF NOT EXISTS tftp_config (
    id           INTEGER PRIMARY KEY DEFAULT 1 CHECK(id = 1),
    bind_host    TEXT    NOT NULL DEFAULT '0.0.0.0',
    bind_port    INTEGER NOT NULL DEFAULT 69,
    root_dir     TEXT    NOT NULL DEFAULT '',   -- empty = default_tftp_root() at read time
    read_only    INTEGER NOT NULL DEFAULT 0,
    auto_start   INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
INSERT OR IGNORE INTO tftp_config (id) VALUES (1);

-- Append-only transfer log for the live feed. Capped via LIMIT in app code.
CREATE TABLE IF NOT EXISTS tftp_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    kind       TEXT    NOT NULL,  -- 'read'|'write'|'error'|'info'
    client_ip  TEXT,
    path       TEXT,
    detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_tftp_events_ts ON tftp_events(ts DESC);
