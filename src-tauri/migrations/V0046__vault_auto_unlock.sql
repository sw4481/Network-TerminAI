-- V0046: Add auto-unlock feature for vault envelopes
--
-- Allows envelopes to automatically unlock on app startup by storing
-- the passphrase in macOS Keychain. Opt-in per envelope for convenience
-- without sacrificing security for production vaults.

ALTER TABLE vault_envelopes ADD COLUMN auto_unlock INTEGER DEFAULT 0 NOT NULL;

-- Index for startup query (find all auto-unlock envelopes)
CREATE INDEX idx_vault_envelopes_auto_unlock ON vault_envelopes(auto_unlock) WHERE auto_unlock = 1;
