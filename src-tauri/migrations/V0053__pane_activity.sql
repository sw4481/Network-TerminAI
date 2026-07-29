-- V0053: Pane activity tracking for AI assistant context
-- Ephemeral state (cleared on tab close), not long-term history.

CREATE TABLE IF NOT EXISTS pane_activity (
    pane_id TEXT PRIMARY KEY,
    tab_id TEXT NOT NULL,
    active_command_json TEXT,  -- nullable: JSON serialized CommandState
    cwd TEXT NOT NULL DEFAULT '/',
    last_focus_time INTEGER,  -- Unix timestamp in seconds
    notification_state TEXT NOT NULL DEFAULT 'idle',  -- 'idle' | 'running' | 'needs_attention'
    updated_at INTEGER NOT NULL,  -- Unix timestamp in seconds
    FOREIGN KEY(tab_id) REFERENCES tabs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pane_activity_tab
ON pane_activity(tab_id);

CREATE INDEX IF NOT EXISTS idx_pane_activity_notification
ON pane_activity(notification_state)
WHERE notification_state = 'needs_attention';
