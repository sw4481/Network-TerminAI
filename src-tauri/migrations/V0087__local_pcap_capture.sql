-- V0087 - permit PCAP rows captured directly from this computer.
-- SQLite cannot alter a CHECK constraint in place, so rebuild the table while
-- preserving every row and recreating the original indexes.

CREATE TABLE pcap_captures_v0087 (
  id            TEXT    PRIMARY KEY,
  session_id    TEXT,
  device_ref    TEXT    NOT NULL,
  device_kind   TEXT    NOT NULL CHECK (device_kind IN ('iosxe','nxos','junos','eos','local')),
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

INSERT INTO pcap_captures_v0087 (
  id, session_id, device_ref, device_kind, interface, filter, started_at,
  ended_at, status, local_path, packet_count, size_bytes, error, created_at
)
SELECT
  id, session_id, device_ref, device_kind, interface, filter, started_at,
  ended_at, status, local_path, packet_count, size_bytes, error, created_at
FROM pcap_captures;

DROP TABLE pcap_captures;
ALTER TABLE pcap_captures_v0087 RENAME TO pcap_captures;

CREATE INDEX idx_pcap_captures_session ON pcap_captures(session_id);
CREATE INDEX idx_pcap_captures_status  ON pcap_captures(status);
CREATE INDEX idx_pcap_captures_created ON pcap_captures(created_at DESC);
