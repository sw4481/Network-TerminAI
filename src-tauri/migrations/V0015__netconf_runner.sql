-- NETCONF tab support: devices, sessions, saved RPCs, history, YANG model cache.
-- No schema change to `tabs`: the existing `tab_type TEXT` column (added by
-- V0013) accepts 'netconf' without modification.

CREATE TABLE IF NOT EXISTS netconf_devices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL UNIQUE,
  host            TEXT    NOT NULL,
  port            INTEGER NOT NULL DEFAULT 830,
  username        TEXT    NOT NULL,
  platform        TEXT    NOT NULL DEFAULT 'iosxe',
  hostkey_verify  INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS netconf_tab_state (
  tab_id            TEXT    PRIMARY KEY REFERENCES tabs(id) ON DELETE CASCADE,
  device_id         INTEGER REFERENCES netconf_devices(id) ON DELETE SET NULL,
  ad_hoc_host       TEXT,
  ad_hoc_port       INTEGER,
  ad_hoc_username   TEXT,
  editor_mode       TEXT    NOT NULL DEFAULT 'raw_xml',
  editor_content    TEXT    NOT NULL DEFAULT '',
  target_datastore  TEXT    NOT NULL DEFAULT 'running',
  session_id        TEXT
);

CREATE TABLE IF NOT EXISTS netconf_saved_rpcs (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL UNIQUE,
  editor_mode  TEXT    NOT NULL,
  content      TEXT    NOT NULL,
  operation    TEXT    NOT NULL,
  target       TEXT,
  platform     TEXT,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS netconf_history (
  id                 TEXT    PRIMARY KEY,
  tab_id             TEXT    REFERENCES tabs(id) ON DELETE SET NULL,
  saved_rpc_id       TEXT    REFERENCES netconf_saved_rpcs(id) ON DELETE SET NULL,
  device_id          INTEGER REFERENCES netconf_devices(id) ON DELETE SET NULL,
  host               TEXT,
  operation          TEXT    NOT NULL,
  target_datastore   TEXT,
  request_xml        TEXT    NOT NULL,
  response_xml       TEXT,
  response_truncated INTEGER NOT NULL DEFAULT 0,
  status             TEXT    NOT NULL,
  error_message      TEXT,
  duration_ms        INTEGER,
  sent_at            INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_nc_hist_tab ON netconf_history(tab_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS yang_releases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor         TEXT    NOT NULL,
  os             TEXT    NOT NULL,
  release        TEXT    NOT NULL,
  source_path    TEXT    NOT NULL,
  cache_dir      TEXT    NOT NULL,
  module_count   INTEGER NOT NULL DEFAULT 0,
  downloaded_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(vendor, os, release)
);

CREATE TABLE IF NOT EXISTS yang_modules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id   INTEGER NOT NULL REFERENCES yang_releases(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  namespace    TEXT,
  revision     TEXT,
  file_path    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_yang_mod_release ON yang_modules(release_id);
CREATE INDEX IF NOT EXISTS idx_yang_mod_name    ON yang_modules(name);
