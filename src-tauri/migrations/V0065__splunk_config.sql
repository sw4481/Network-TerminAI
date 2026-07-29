-- Cisco Splunk connection settings (singleton row). Auth is a Bearer token
-- (Splunk authentication token / Splunk Cloud) OR HTTP Basic (username/password);
-- the client prefers the token when present. Management API is HTTPS on 8089.
CREATE TABLE IF NOT EXISTS splunk_config (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    host         TEXT NOT NULL DEFAULT '',
    port         INTEGER NOT NULL DEFAULT 8089,
    token        TEXT NOT NULL DEFAULT '',
    username     TEXT NOT NULL DEFAULT '',
    password     TEXT NOT NULL DEFAULT '',
    verify_ssl   INTEGER NOT NULL DEFAULT 0   -- default OFF: Splunk ships a self-signed cert
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_splunk_config_singleton
ON splunk_config(id);
