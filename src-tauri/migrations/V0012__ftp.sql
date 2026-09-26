-- FTP server config (singleton row)
CREATE TABLE IF NOT EXISTS ftp_config (
    id           INTEGER PRIMARY KEY DEFAULT 1 CHECK(id = 1),
    bind_host    TEXT    NOT NULL DEFAULT '0.0.0.0',
    bind_port    INTEGER NOT NULL DEFAULT 2121,
    passive_min  INTEGER NOT NULL DEFAULT 49152,
    passive_max  INTEGER NOT NULL DEFAULT 49200,
    greeting     TEXT    NOT NULL DEFAULT 'CCIE Terminal FTP',
    auto_start   INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
INSERT OR IGNORE INTO ftp_config (id) VALUES (1);

-- FTP users
CREATE TABLE IF NOT EXISTS ftp_users (
    id          TEXT    PRIMARY KEY,
    username    TEXT    NOT NULL UNIQUE,
    password    TEXT    NOT NULL,
    home_dir    TEXT    NOT NULL,
    read_only   INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Append-only event log for the live transfer feed. Capped via LIMIT in
-- application code — keep the last ~5k events.
CREATE TABLE IF NOT EXISTS ftp_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    kind       TEXT    NOT NULL,  -- 'login'|'logout'|'stor'|'retr'|'list'|'del'|'mkdir'|'error'|'info'
    username   TEXT,
    client_ip  TEXT,
    path       TEXT,
    detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_ftp_events_ts ON ftp_events(ts DESC);
