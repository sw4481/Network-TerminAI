-- SSH Saved Connections
-- Store frequently used SSH connection details for quick access

CREATE TABLE IF NOT EXISTS ssh_connections (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    user TEXT,
    port INTEGER DEFAULT 22,
    identity_file TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_used_at INTEGER,
    UNIQUE(host, user, port)
);

CREATE INDEX idx_ssh_connections_name ON ssh_connections(name);
CREATE INDEX idx_ssh_connections_last_used ON ssh_connections(last_used_at DESC);
