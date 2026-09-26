-- Cisco Modeling Labs (CML) connection settings (singleton row).
CREATE TABLE IF NOT EXISTS cml_config (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    host         TEXT NOT NULL DEFAULT '',
    username     TEXT NOT NULL DEFAULT '',
    password     TEXT NOT NULL DEFAULT '',
    verify_ssl   INTEGER NOT NULL DEFAULT 0   -- default OFF: CML ships a self-signed cert
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cml_config_singleton
ON cml_config(id);
