-- Plan 14 Phase 1: Credential vault + session recording schema.
-- All five new tables in one migration.

-- Vault envelopes: logical grouping (per-site or per-customer)
CREATE TABLE IF NOT EXISTS vault_envelopes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  kdf_params_json TEXT NOT NULL,        -- {"algo":"argon2id","m":65536,"t":3,"p":1}
  salt_blob BLOB NOT NULL,              -- per-envelope salt (16 bytes min)
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Secrets: metadata only. Plaintext lives in OS keyring under `keyring_ref`.
CREATE TABLE IF NOT EXISTS vault_secrets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  envelope_id TEXT NOT NULL REFERENCES vault_envelopes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('password','ssh_key','api_token','snmp_community','netconf')),
  label TEXT NOT NULL,
  keyring_ref TEXT NOT NULL UNIQUE,     -- e.g. ccie-terminal.vault.<envelope_id>.<secret_id>
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at INTEGER,
  rotates_at INTEGER,                   -- unix; advisory
  expires_at INTEGER                    -- unix; advisory
);
CREATE INDEX IF NOT EXISTS idx_vault_secrets_envelope ON vault_secrets(envelope_id);
CREATE INDEX IF NOT EXISTS idx_vault_secrets_kind ON vault_secrets(kind);

-- Vault session audit log (unlock events). Unlocked state is process-memory only.
CREATE TABLE IF NOT EXISTS vault_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  envelope_id TEXT NOT NULL REFERENCES vault_envelopes(id) ON DELETE CASCADE,
  unlocked_at INTEGER NOT NULL DEFAULT (unixepoch()),
  locked_at INTEGER,                    -- null while active; set on lock/idle/exit
  reason TEXT                           -- 'manual','idle','app_exit','wrong_passphrase'
);
CREATE INDEX IF NOT EXISTS idx_vault_sessions_envelope ON vault_sessions(envelope_id);
CREATE INDEX IF NOT EXISTS idx_vault_sessions_unlocked ON vault_sessions(unlocked_at DESC);

-- Session recordings (asciinema v2)
CREATE TABLE IF NOT EXISTS session_recordings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  tab_id TEXT NOT NULL,                 -- loose FK; tabs are UI-scoped
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ended_at INTEGER,
  path TEXT NOT NULL UNIQUE,            -- absolute path to .cast file
  size_bytes INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  session_kind TEXT NOT NULL CHECK (session_kind IN ('local','ssh','netconf','sidecar'))
);
CREATE INDEX IF NOT EXISTS idx_session_recordings_tab ON session_recordings(tab_id);
CREATE INDEX IF NOT EXISTS idx_session_recordings_started ON session_recordings(started_at DESC);

-- Redaction audit: per-pattern match counts per recording
CREATE TABLE IF NOT EXISTS recording_redactions (
  recording_id TEXT NOT NULL REFERENCES session_recordings(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL,
  replacement_hash TEXT NOT NULL,       -- sha256 of replacement bytes (for forensic replay validation)
  matches INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (recording_id, pattern)
);
