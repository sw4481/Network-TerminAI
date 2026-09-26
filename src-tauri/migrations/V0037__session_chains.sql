-- V0037 — Session chains (jump-host hop sequences)
--
-- Persists ordered chains of hops (laptop → jump → core → leaf) so tabs can
-- restore their full hop sequence on app restart, tab reopen, or network blip.
-- Hops reference existing credential rows by (target_kind, target_ref) — raw
-- secrets are NEVER copied into chain rows. Resolution happens in Rust.

CREATE TABLE IF NOT EXISTS session_chains (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL UNIQUE,
  description  TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS session_chain_hops (
  chain_id                TEXT    NOT NULL REFERENCES session_chains(id) ON DELETE CASCADE,
  idx                     INTEGER NOT NULL,
  hop_kind                TEXT    NOT NULL CHECK (hop_kind IN ('ssh','netconf','telnet','console')),
  target_ref              TEXT    NOT NULL,
  target_kind             TEXT    NOT NULL CHECK (target_kind IN ('ssh_connection','netconf_device','ad_hoc')),
  post_connect_cmds_json  TEXT    NOT NULL DEFAULT '[]',
  timeout_ms              INTEGER NOT NULL DEFAULT 15000,
  PRIMARY KEY (chain_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_chain_hops_target ON session_chain_hops(target_kind, target_ref);

CREATE TABLE IF NOT EXISTS jump_host_links (
  parent_chain_id  TEXT NOT NULL REFERENCES session_chains(id) ON DELETE CASCADE,
  child_chain_id   TEXT NOT NULL REFERENCES session_chains(id) ON DELETE CASCADE,
  UNIQUE(parent_chain_id, child_chain_id)
);
CREATE INDEX IF NOT EXISTS idx_jump_host_links_child ON jump_host_links(child_chain_id);

ALTER TABLE tabs ADD COLUMN chain_id TEXT REFERENCES session_chains(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tabs_chain ON tabs(chain_id);
