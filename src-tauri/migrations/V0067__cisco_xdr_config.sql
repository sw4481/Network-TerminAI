-- Cisco XDR (Extended Detection & Response) connection config.
-- Singleton row (id = 1). OAuth2 client_credentials against regional hosts.
CREATE TABLE IF NOT EXISTS cisco_xdr_config (
    id              INTEGER PRIMARY KEY CHECK (id = 1),       -- Singleton
    region          TEXT    NOT NULL DEFAULT 'nam',           -- nam|eu|apjc
    client_id       TEXT    NOT NULL DEFAULT '',              -- API client ID
    client_password TEXT    NOT NULL DEFAULT '',              -- API client password/secret
    verify_ssl      INTEGER NOT NULL DEFAULT 1                -- 0|1 (boolean)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cisco_xdr_config_singleton
ON cisco_xdr_config(id);
