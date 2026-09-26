-- WhatsApp bridge config (personal linked-device transport via neonize).
-- Singleton row (id = 1). No credential column: the linked-device *session*
-- authenticates and is persisted by neonize to `session_dir` on disk.
CREATE TABLE IF NOT EXISTS whatsapp_config (
    id                    INTEGER PRIMARY KEY CHECK (id = 1),          -- Singleton
    enabled               INTEGER NOT NULL DEFAULT 0,                  -- 0|1 master switch
    default_agent_id      TEXT    NOT NULL DEFAULT 'network-architect',-- agent used when a message has no /agent-id prefix
    allowlist_json        TEXT    NOT NULL DEFAULT '[]',               -- JSON array of E.164 numbers permitted to drive agents
    notify_severities_json TEXT   NOT NULL DEFAULT '["critical","error"]', -- heartbeat severities that push a WhatsApp alert
    session_dir           TEXT    NOT NULL DEFAULT ''                  -- neonize device-session directory (empty => default under app config)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_singleton
ON whatsapp_config(id);
