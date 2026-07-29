-- V0038 — Packet capture rows + vendor templates (Plan 11)
--
-- pcap_captures: one row per capture lifecycle (setup → capturing → pulling →
-- ready | failed). `local_path` is the on-host pcap after SFTP pull; nullable
-- until the orchestrator finalizes.
--
-- pcap_templates: vendor presets the quick-capture wizard surfaces. `builtin=1`
-- rows are seeded here and treated as read-only by the CRUD layer.

CREATE TABLE IF NOT EXISTS pcap_captures (
  id            TEXT    PRIMARY KEY,
  session_id    TEXT,
  device_ref    TEXT    NOT NULL,
  device_kind   TEXT    NOT NULL CHECK (device_kind IN ('iosxe','nxos','junos','eos')),
  interface     TEXT    NOT NULL,
  filter        TEXT,
  started_at    INTEGER,
  ended_at      INTEGER,
  status        TEXT    NOT NULL CHECK (status IN ('setup','capturing','pulling','ready','failed')),
  local_path    TEXT,
  packet_count  INTEGER,
  size_bytes    INTEGER,
  error         TEXT,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_pcap_captures_session ON pcap_captures(session_id);
CREATE INDEX IF NOT EXISTS idx_pcap_captures_status  ON pcap_captures(status);
CREATE INDEX IF NOT EXISTS idx_pcap_captures_created ON pcap_captures(created_at DESC);

CREATE TABLE IF NOT EXISTS pcap_templates (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  vendor      TEXT    NOT NULL,
  platform    TEXT    NOT NULL,
  interface   TEXT,
  acl         TEXT,
  duration_s  INTEGER NOT NULL DEFAULT 30,
  builtin     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_pcap_templates_vendor ON pcap_templates(vendor, platform);

INSERT INTO pcap_templates (id, name, vendor, platform, interface, acl, duration_s, builtin) VALUES
  ('tpl-iosxe-wan',  'IOS-XE WAN any-any',             'cisco',   'iosxe', '<WAN_IF>',      NULL, 30, 1),
  ('tpl-iosxe-cp',   'IOS-XE control-plane',           'cisco',   'iosxe', 'control-plane', NULL, 20, 1),
  ('tpl-nxos-mgmt',  'NX-OS mgmt0 ethanalyzer',        'cisco',   'nxos',  'mgmt0',         NULL, 30, 1),
  ('tpl-junos-ge',   'Junos monitor traffic ge-0/0/0', 'juniper', 'junos', 'ge-0/0/0',      NULL, 30, 1);
