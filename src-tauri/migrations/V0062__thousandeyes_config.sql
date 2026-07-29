-- Cisco ThousandEyes API settings (singleton row). Token-only auth; the
-- optional account_group_id scopes calls to one account group.
CREATE TABLE IF NOT EXISTS thousandeyes_config (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    token             TEXT NOT NULL DEFAULT '',
    account_group_id  TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_thousandeyes_config_singleton
ON thousandeyes_config(id);
