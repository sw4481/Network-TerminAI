-- V0069: versioned running-config archive per device.
CREATE TABLE IF NOT EXISTS config_snapshots (
  id                TEXT PRIMARY KEY,
  device_id         TEXT NOT NULL,
  device_kind       TEXT NOT NULL,
  vendor            TEXT,
  platform          TEXT,
  normalized_config TEXT NOT NULL,
  label             TEXT,
  source            TEXT NOT NULL CHECK (source IN ('drift_run','manual')),
  captured_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_config_snapshots_device_time
  ON config_snapshots(device_id, device_kind, captured_at DESC);
