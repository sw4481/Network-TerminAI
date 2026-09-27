-- AI Provider Configuration
CREATE TABLE IF NOT EXISTS ai_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    api_key TEXT,
    base_url TEXT,
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Ensure only one config row
CREATE UNIQUE INDEX idx_ai_config_singleton ON ai_config(id);
