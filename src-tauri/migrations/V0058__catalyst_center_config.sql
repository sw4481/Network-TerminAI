-- Cisco Catalyst Center (DNA Center) connection settings (singleton row).
CREATE TABLE IF NOT EXISTS catalyst_center_config (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    host         TEXT NOT NULL DEFAULT '',
    username     TEXT NOT NULL DEFAULT '',
    password     TEXT NOT NULL DEFAULT '',
    verify_ssl   INTEGER NOT NULL DEFAULT 0   -- default OFF: Catalyst Center ships a self-signed cert
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_catalyst_center_config_singleton
ON catalyst_center_config(id);
