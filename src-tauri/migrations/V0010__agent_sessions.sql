-- Per-tab active agent binding + optional persisted turn history
CREATE TABLE IF NOT EXISTS agent_sessions (
    tab_id      TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL,
    turns_json  TEXT NOT NULL DEFAULT '[]',
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent_id
    ON agent_sessions(agent_id);
