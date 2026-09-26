//! `config_snapshots` — versioned normalized running-config per device.
//! Dedups identical-consecutive captures; retains newest N unlabeled per
//! device (labeled snapshots are never auto-evicted).

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const RETENTION_PER_DEVICE: i64 = 15;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ConfigSnapshot {
    pub id: String,
    pub device_id: String,
    pub device_kind: String,
    pub vendor: Option<String>,
    pub platform: Option<String>,
    pub normalized_config: String,
    pub label: Option<String>,
    pub source: String,
    pub captured_at: i64,
}

pub struct ConfigSnapshotRepo;

impl ConfigSnapshotRepo {
    /// Insert a snapshot unless it's byte-identical to the device's most
    /// recent one (dedup → returns Ok(None)). Enforces retention after insert.
    pub fn insert(
        conn: &Connection,
        device_id: &str,
        device_kind: &str,
        vendor: &str,
        platform: &str,
        normalized_config: &str,
        source: &str,
    ) -> Result<Option<ConfigSnapshot>> {
        let latest: Option<String> = conn
            .query_row(
                "SELECT normalized_config FROM config_snapshots
                 WHERE device_id = ?1 AND device_kind = ?2
                 ORDER BY captured_at DESC LIMIT 1",
                params![device_id, device_kind],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        if latest.as_deref() == Some(normalized_config) {
            return Ok(None); // dedup
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO config_snapshots
                (id, device_id, device_kind, vendor, platform, normalized_config, source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, device_id, device_kind, vendor, platform, normalized_config, source],
        )
        .context("insert config_snapshots")?;
        Self::enforce_retention(conn, device_id, device_kind)?;
        Self::get(conn, &id)
    }

    /// Delete oldest UNLABELED snapshots beyond RETENTION_PER_DEVICE. Labeled
    /// snapshots are never counted or evicted. Deterministic: deletes unlabeled
    /// rows strictly older than the RETENTION_PER_DEVICE-th newest unlabeled row.
    pub fn enforce_retention(conn: &Connection, device_id: &str, device_kind: &str) -> Result<()> {
        conn.execute(
            "DELETE FROM config_snapshots
             WHERE device_id = ?1 AND device_kind = ?2 AND label IS NULL
               AND captured_at < (
                 SELECT captured_at FROM config_snapshots
                 WHERE device_id = ?1 AND device_kind = ?2 AND label IS NULL
                 ORDER BY captured_at DESC
                 LIMIT 1 OFFSET ?3
               )",
            params![device_id, device_kind, RETENTION_PER_DEVICE - 1],
        )?;
        Ok(())
    }

    pub fn get(conn: &Connection, id: &str) -> Result<Option<ConfigSnapshot>> {
        let row = conn
            .query_row(
                "SELECT id, device_id, device_kind, vendor, platform,
                        normalized_config, label, source, captured_at
                 FROM config_snapshots WHERE id = ?1",
                [id],
                Self::map_row,
            )
            .optional()?;
        Ok(row)
    }

    /// List a device's snapshots newest-first. `normalized_config` is included
    /// (callers that only need metadata can ignore it).
    pub fn list_for_device(
        conn: &Connection,
        device_id: &str,
        device_kind: &str,
        limit: i64,
    ) -> Result<Vec<ConfigSnapshot>> {
        let mut stmt = conn.prepare(
            "SELECT id, device_id, device_kind, vendor, platform,
                    normalized_config, label, source, captured_at
             FROM config_snapshots
             WHERE device_id = ?1 AND device_kind = ?2
             ORDER BY captured_at DESC LIMIT ?3",
        )?;
        let rows = stmt
            .query_map(params![device_id, device_kind, limit], Self::map_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn set_label(conn: &Connection, id: &str, label: Option<&str>) -> Result<()> {
        let n = conn.execute(
            "UPDATE config_snapshots SET label = ?1 WHERE id = ?2",
            params![label, id],
        )?;
        if n == 0 {
            anyhow::bail!("config_snapshot id={id} not found");
        }
        Ok(())
    }

    fn map_row(row: &rusqlite::Row) -> rusqlite::Result<ConfigSnapshot> {
        Ok(ConfigSnapshot {
            id: row.get(0)?,
            device_id: row.get(1)?,
            device_kind: row.get(2)?,
            vendor: row.get(3)?,
            platform: row.get(4)?,
            normalized_config: row.get(5)?,
            label: row.get(6)?,
            source: row.get(7)?,
            captured_at: row.get(8)?,
        })
    }
}
