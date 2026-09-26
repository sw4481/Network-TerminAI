use anyhow::Result;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;

/// Thread-safe handle around a SQLite `parsers_cache` table.
/// Clones share the same underlying connection (wrapped in `parking_lot::Mutex`).
#[derive(Clone)]
pub struct ParseCache {
    conn: Arc<Mutex<Connection>>,
}

pub struct CacheHit {
    pub parser: String,
    pub data_json: String,
}

impl ParseCache {
    /// Wrap an existing `Connection` (the main app DB, already migrated).
    pub fn from_connection(conn: Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }

    /// Open a standalone DB at `path` and ensure the `parsers_cache` table exists.
    /// Used by unit tests; production code uses `from_connection`.
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS parsers_cache (
                key TEXT PRIMARY KEY,
                vendor TEXT NOT NULL,
                platform TEXT NOT NULL,
                command TEXT NOT NULL,
                parser TEXT NOT NULL,
                data_json TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            );",
        )?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn key(&self, vendor: &str, platform: &str, command: &str, raw: &str) -> String {
        let mut h = Sha256::new();
        h.update(vendor.as_bytes());
        h.update(b"|");
        h.update(platform.as_bytes());
        h.update(b"|");
        h.update(command.as_bytes());
        h.update(b"|");
        h.update(raw.as_bytes());
        format!("{:x}", h.finalize())
    }

    pub fn get(&self, key: &str) -> Result<Option<CacheHit>> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT parser, data_json FROM parsers_cache WHERE key = ?1")?;
        let row = stmt.query_row(params![key], |r| {
            Ok(CacheHit {
                parser: r.get(0)?,
                data_json: r.get(1)?,
            })
        });
        match row {
            Ok(h) => Ok(Some(h)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn put(
        &self,
        key: &str,
        vendor: &str,
        platform: &str,
        command: &str,
        parser: &str,
        data_json: &str,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO parsers_cache(key, vendor, platform, command, parser, data_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![key, vendor, platform, command, parser, data_json],
        )?;
        Ok(())
    }
}
