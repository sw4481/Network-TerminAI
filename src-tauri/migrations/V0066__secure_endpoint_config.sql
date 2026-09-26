-- Cisco Secure Endpoint (AMP for Endpoints) connection settings (singleton).
-- region selects the regional API host (nam|eu|apjc). auth_mode is v1_basic
-- (HTTP Basic, default) or v3_oauth (OAuth bearer). api_key holds the v1 API key
-- or the v3 client secret. verify_ssl defaults ON: hosts are Cisco-signed.
CREATE TABLE IF NOT EXISTS secure_endpoint_config (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    region      TEXT    NOT NULL DEFAULT 'nam',
    auth_mode   TEXT    NOT NULL DEFAULT 'v1_basic',
    client_id   TEXT    NOT NULL DEFAULT '',
    api_key     TEXT    NOT NULL DEFAULT '',
    verify_ssl  INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_secure_endpoint_config_singleton
ON secure_endpoint_config(id);
