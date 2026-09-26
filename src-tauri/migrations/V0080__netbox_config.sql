-- NetBox DCIM/IPAM source-of-truth configuration (singleton)
CREATE TABLE IF NOT EXISTS netbox_config (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    url          TEXT NOT NULL DEFAULT '',
    token        TEXT NOT NULL DEFAULT '',
    verify_ssl   INTEGER NOT NULL DEFAULT 1
);

-- Enforce single-row constraint
CREATE UNIQUE INDEX IF NOT EXISTS idx_netbox_config_singleton
ON netbox_config(id);
