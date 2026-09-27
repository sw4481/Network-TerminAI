-- Proxmox VE connection details, single row (id = 1). Stored like ai_config
-- (V0009), NOT in the encrypted vault, so the sidecar can read it directly for
-- every agent. Same plaintext bar as the existing LLM api_key.
CREATE TABLE IF NOT EXISTS proxmox_config (
    id           INTEGER PRIMARY KEY,
    host         TEXT,
    port         INTEGER NOT NULL DEFAULT 8006,
    user         TEXT NOT NULL DEFAULT 'root@pam',
    token_name   TEXT NOT NULL DEFAULT '',
    token_value  TEXT NOT NULL DEFAULT '',
    password     TEXT NOT NULL DEFAULT '',
    verify_ssl   INTEGER NOT NULL DEFAULT 0
);
