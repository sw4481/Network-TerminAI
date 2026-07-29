-- Sketchfab 3D-model configuration (singleton). API key is optional.
CREATE TABLE IF NOT EXISTS sketchfab_config (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    api_key  TEXT NOT NULL DEFAULT ''
);

-- Enforce single-row constraint
CREATE UNIQUE INDEX IF NOT EXISTS idx_sketchfab_config_singleton
ON sketchfab_config(id);
