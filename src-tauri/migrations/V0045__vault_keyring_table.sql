-- Plan 14 follow-up: Store vault keyring entries in database instead of macOS Keychain
-- due to Tauri runtime Keychain access issues.
--
-- Security note: The values stored here are encrypted master keys and canaries,
-- encrypted with Argon2id-derived keys from user passphrases. They are NOT plaintext.

CREATE TABLE IF NOT EXISTS vault_keyring (
    account TEXT PRIMARY KEY NOT NULL,
    value_blob BLOB NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE INDEX IF NOT EXISTS idx_vault_keyring_created ON vault_keyring(created_at);
