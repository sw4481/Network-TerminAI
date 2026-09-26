-- Prometheus metrics configuration (singleton)
CREATE TABLE IF NOT EXISTS prometheus_config (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    url          TEXT NOT NULL DEFAULT '',
    username     TEXT NOT NULL DEFAULT '',
    password     TEXT NOT NULL DEFAULT '',
    token        TEXT NOT NULL DEFAULT '',
    org_id       TEXT NOT NULL DEFAULT '',
    verify_ssl   INTEGER NOT NULL DEFAULT 1
);

-- Enforce single-row constraint
CREATE UNIQUE INDEX IF NOT EXISTS idx_prometheus_config_singleton
ON prometheus_config(id);
