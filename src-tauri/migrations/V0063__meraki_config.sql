-- Cisco Meraki Dashboard API settings (singleton row). Meraki auth is a single
-- API key; org_id is an optional default scope. This mirrors the other vendor
-- config tables so the sidecar can read the key directly from sessions.db
-- (previously the key lived only in the encrypted vault, which the sidecar
-- cannot decrypt — blocking the Network Architect's meraki specialist).
CREATE TABLE IF NOT EXISTS meraki_config (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    api_key  TEXT NOT NULL DEFAULT '',
    org_id   TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meraki_config_singleton
ON meraki_config(id);
