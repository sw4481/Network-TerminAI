-- Notification preferences (singleton, id = 1)
CREATE TABLE IF NOT EXISTS notification_preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    min_duration_secs INTEGER NOT NULL DEFAULT 30,
    notify_on_nonzero_exit INTEGER NOT NULL DEFAULT 1,
    notify_on_agent_output INTEGER NOT NULL DEFAULT 1,
    keyword_triggers_json TEXT NOT NULL DEFAULT '["error","failed","timeout"]',
    ignore_commands_json TEXT NOT NULL DEFAULT '["tail","watch","top","htop"]',
    enable_sound INTEGER NOT NULL DEFAULT 0
);

-- Insert default preferences
INSERT OR IGNORE INTO notification_preferences (id) VALUES (1);
