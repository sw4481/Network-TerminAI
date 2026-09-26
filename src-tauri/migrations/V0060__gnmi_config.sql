-- gNMI target list (singleton row). gNMI is multi-target, so the connection
-- set is stored as a JSON array in targets_json rather than discrete columns.
-- Each element: {name, host, port, username, password, vendor, skip_verify}.
CREATE TABLE IF NOT EXISTS gnmi_config (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    targets_json  TEXT NOT NULL DEFAULT '[]'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gnmi_config_singleton
ON gnmi_config(id);
