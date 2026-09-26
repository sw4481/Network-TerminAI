CREATE TABLE IF NOT EXISTS check_bundles (
  id          TEXT PRIMARY KEY,                -- uuidv4
  name        TEXT NOT NULL,
  description TEXT,
  vendor      TEXT NOT NULL,                   -- e.g. 'cisco'
  platform    TEXT NOT NULL,                   -- e.g. 'iosxe','nxos','junos'
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(name, vendor, platform)
);
CREATE INDEX IF NOT EXISTS idx_check_bundles_vendor_platform
  ON check_bundles(vendor, platform);

CREATE TABLE IF NOT EXISTS check_bundle_commands (
  bundle_id  TEXT NOT NULL REFERENCES check_bundles(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,                 -- 0-based ordering
  command    TEXT NOT NULL,
  PRIMARY KEY (bundle_id, idx)
);

CREATE TABLE IF NOT EXISTS change_snapshots (
  id           TEXT PRIMARY KEY,               -- uuidv4
  tab_id       TEXT NOT NULL,
  bundle_id    TEXT NOT NULL REFERENCES check_bundles(id) ON DELETE RESTRICT,
  label        TEXT NOT NULL CHECK (label IN ('pre','post')),
  captured_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_change_snapshots_tab
  ON change_snapshots(tab_id, captured_at DESC);

-- parsed_output_id is an INT pointer into parsed_outputs(id) (Plan 05 / V0032) but
-- intentionally NOT declared as REFERENCES to avoid cross-feature CASCADE coupling.
-- parsed_outputs cascades from command_blocks, so its rows can disappear before a
-- snapshot row does. Phase 2+ readers must LEFT JOIN and tolerate missing rows;
-- a missing parsed_output is treated as "data expired", not "data corrupt".
CREATE TABLE IF NOT EXISTS change_snapshot_results (
  snapshot_id       TEXT NOT NULL REFERENCES change_snapshots(id) ON DELETE CASCADE,
  command           TEXT NOT NULL,
  parsed_output_id  INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, command)
);

CREATE TABLE IF NOT EXISTS change_reports (
  id                    TEXT PRIMARY KEY,      -- uuidv4
  pre_snapshot_id       TEXT NOT NULL REFERENCES change_snapshots(id) ON DELETE CASCADE,
  post_snapshot_id      TEXT NOT NULL REFERENCES change_snapshots(id) ON DELETE CASCADE,
  summary_json          TEXT NOT NULL,         -- serialized ReportSummary
  approved_deltas_json  TEXT,                  -- serialized Vec<ExpectedDelta>, nullable
  created_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(pre_snapshot_id, post_snapshot_id)
);
CREATE INDEX IF NOT EXISTS idx_change_reports_created
  ON change_reports(created_at DESC);
