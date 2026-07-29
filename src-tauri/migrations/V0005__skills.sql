-- Skills table for Phase 5
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    when_to_use TEXT NOT NULL,
    playbook TEXT NOT NULL,
    scripts TEXT, -- JSON array of script paths
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Index for efficient lookups by name
CREATE INDEX idx_skills_name ON skills(name);

-- Index for enabled skills
CREATE INDEX idx_skills_enabled ON skills(enabled);
