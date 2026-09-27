-- Cisco Stealthwatch Enterprise configuration (singleton)
CREATE TABLE IF NOT EXISTS stealthwatch_config (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    host         TEXT NOT NULL DEFAULT '',
    username     TEXT NOT NULL DEFAULT '',
    password     TEXT NOT NULL DEFAULT '',
    verify_ssl   INTEGER NOT NULL DEFAULT 1
);

-- Enforce single-row constraint
CREATE UNIQUE INDEX IF NOT EXISTS idx_stealthwatch_config_singleton
ON stealthwatch_config(id);
