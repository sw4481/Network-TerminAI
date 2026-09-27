-- Cisco Identity Services Engine (ISE) configuration (singleton)
CREATE TABLE IF NOT EXISTS ise_config (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    host         TEXT NOT NULL DEFAULT '',
    username     TEXT NOT NULL DEFAULT '',
    password     TEXT NOT NULL DEFAULT '',
    verify_ssl   INTEGER NOT NULL DEFAULT 1
);

-- Enforce single-row constraint
CREATE UNIQUE INDEX IF NOT EXISTS idx_ise_config_singleton
ON ise_config(id);
