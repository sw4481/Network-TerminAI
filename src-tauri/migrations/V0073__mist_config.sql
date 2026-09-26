-- Juniper Mist connection config.
-- Singleton row (id = 1). Static API token against one regional host.
CREATE TABLE IF NOT EXISTS mist_config (
    id          INTEGER PRIMARY KEY CHECK (id = 1),       -- Singleton
    region      TEXT    NOT NULL DEFAULT 'global01',       -- global01|global02|global03|emea01|emea02|apac01
    api_token   TEXT    NOT NULL DEFAULT '',               -- Mist API token (Authorization: Token <api_token>)
    verify_ssl  INTEGER NOT NULL DEFAULT 1                 -- 0|1 (boolean)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mist_config_singleton
ON mist_config(id);
