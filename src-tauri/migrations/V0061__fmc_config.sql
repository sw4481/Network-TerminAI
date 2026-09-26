-- Cisco Secure Firewall Management Center (FMC) connection settings (singleton).
-- domain_uuid is optional: blank means use the FMC-reported default domain.
CREATE TABLE IF NOT EXISTS fmc_config (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    host         TEXT NOT NULL DEFAULT '',
    username     TEXT NOT NULL DEFAULT '',
    password     TEXT NOT NULL DEFAULT '',
    domain_uuid  TEXT NOT NULL DEFAULT '',
    verify_ssl   INTEGER NOT NULL DEFAULT 0   -- default OFF: FMC ships a self-signed cert
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fmc_config_singleton
ON fmc_config(id);
