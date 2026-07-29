//! YANG model cache management: indexing releases and modules from YangModels/yang.
//!
//! Downloads from github.com/YangModels/yang are extracted to
//! `~/.ccie-terminal/yang-cache/<vendor>/<os>/<release>/` and indexed in SQLite.
//! The sidecar handles downloads and pyang parsing; Rust provides the query/index layer.

use crate::netconf_runner::error::{NetconfError, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// A YANG release bundle (e.g., cisco/xe/1715).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YangRelease {
    pub id: i64,
    pub vendor: String,
    pub os: String,
    pub release: String,
    pub source_path: String,
    pub cache_dir: String,
    pub module_count: i64,
    pub downloaded_at: String,
}

/// A YANG module within a release.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YangModule {
    pub id: i64,
    pub release_id: i64,
    pub name: String,
    pub namespace: Option<String>,
    pub revision: Option<String>,
    pub file_path: String,
}

/// Get the base cache directory: `~/.ccie-terminal/yang-cache/`.
pub fn cache_base() -> Result<PathBuf> {
    let home = dirs::home_dir()
        .ok_or_else(|| NetconfError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Could not determine home directory",
        )))?;
    let cache = home.join(".ccie-terminal").join("yang-cache");
    Ok(cache)
}

/// List all indexed YANG releases.
pub fn list_releases(db: &Connection) -> Result<Vec<YangRelease>> {
    let mut stmt = db.prepare(
        "SELECT id, vendor, os, release, source_path, cache_dir, module_count, downloaded_at
         FROM yang_releases
         ORDER BY vendor, os, release",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(YangRelease {
            id: row.get(0)?,
            vendor: row.get(1)?,
            os: row.get(2)?,
            release: row.get(3)?,
            source_path: row.get(4)?,
            cache_dir: row.get(5)?,
            module_count: row.get(6)?,
            downloaded_at: row.get(7)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| NetconfError::Database(e.to_string()))
}

/// Get a specific release by ID.
pub fn get_release(db: &Connection, release_id: i64) -> Result<YangRelease> {
    let mut stmt = db.prepare(
        "SELECT id, vendor, os, release, source_path, cache_dir, module_count, downloaded_at
         FROM yang_releases
         WHERE id = ?1",
    )?;
    let release = stmt.query_row([release_id], |row| {
        Ok(YangRelease {
            id: row.get(0)?,
            vendor: row.get(1)?,
            os: row.get(2)?,
            release: row.get(3)?,
            source_path: row.get(4)?,
            cache_dir: row.get(5)?,
            module_count: row.get(6)?,
            downloaded_at: row.get(7)?,
        })
    })?;
    Ok(release)
}

/// Record a newly downloaded release in the database.
pub fn insert_release(
    db: &Connection,
    vendor: &str,
    os: &str,
    release: &str,
    source_path: &str,
    cache_dir: &str,
) -> Result<i64> {
    let now = chrono::Utc::now().to_rfc3339();
    db.execute(
        "INSERT INTO yang_releases (vendor, os, release, source_path, cache_dir, module_count, downloaded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
        params![vendor, os, release, source_path, cache_dir, now],
    )?;
    Ok(db.last_insert_rowid())
}

/// Delete a release and all its modules from the database.
/// Does NOT delete files from disk - caller must handle that separately.
pub fn delete_release(db: &Connection, release_id: i64) -> Result<()> {
    // Modules are CASCADE deleted via foreign key
    db.execute("DELETE FROM yang_releases WHERE id = ?1", params![release_id])?;
    Ok(())
}

/// List all modules in a release, optionally filtered by name query.
pub fn list_modules(db: &Connection, release_id: i64, query: Option<&str>) -> Result<Vec<YangModule>> {
    if let Some(q) = query.filter(|q| !q.trim().is_empty()) {
        let pattern = format!("%{}%", q);
        let mut stmt = db.prepare(
            "SELECT id, release_id, name, namespace, revision, file_path
             FROM yang_modules
             WHERE release_id = ?1 AND name LIKE ?2
             ORDER BY name",
        )?;
        let rows = stmt.query_map(params![release_id, pattern], |row| {
            Ok(YangModule {
                id: row.get(0)?,
                release_id: row.get(1)?,
                name: row.get(2)?,
                namespace: row.get(3)?,
                revision: row.get(4)?,
                file_path: row.get(5)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| NetconfError::Database(e.to_string()))
    } else {
        let mut stmt = db.prepare(
            "SELECT id, release_id, name, namespace, revision, file_path
             FROM yang_modules
             WHERE release_id = ?1
             ORDER BY name",
        )?;
        let rows = stmt.query_map(params![release_id], |row| {
            Ok(YangModule {
                id: row.get(0)?,
                release_id: row.get(1)?,
                name: row.get(2)?,
                namespace: row.get(3)?,
                revision: row.get(4)?,
                file_path: row.get(5)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| NetconfError::Database(e.to_string()))
    }
}

/// Insert a module into the database after parsing.
pub fn insert_module(
    db: &Connection,
    release_id: i64,
    name: &str,
    namespace: Option<&str>,
    revision: Option<&str>,
    file_path: &str,
) -> Result<i64> {
    db.execute(
        "INSERT INTO yang_modules (release_id, name, namespace, revision, file_path)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![release_id, name, namespace, revision, file_path],
    )?;
    Ok(db.last_insert_rowid())
}

/// Update the module count for a release after indexing.
pub fn update_module_count(db: &Connection, release_id: i64) -> Result<()> {
    db.execute(
        "UPDATE yang_releases
         SET module_count = (SELECT COUNT(*) FROM yang_modules WHERE release_id = ?1)
         WHERE id = ?1",
        params![release_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_yang_cache_crud() {
        let temp_dir = tempfile::TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");
        let mut conn = crate::db::open_and_migrate(&db_path).unwrap();
        let db = &mut conn;

        // Insert release
        let release_id = insert_release(
            db,
            "cisco",
            "xe",
            "1715",
            "github.com/YangModels/yang/cisco/xe/1715",
            "/tmp/yang-cache/cisco/xe/1715",
        ).unwrap();

        // Insert modules
        insert_module(db, release_id, "ietf-interfaces", Some("urn:ietf:params:xml:ns:yang:ietf-interfaces"), Some("2014-05-08"), "/tmp/yang-cache/cisco/xe/1715/ietf-interfaces.yang").unwrap();
        insert_module(db, release_id, "Cisco-IOS-XE-native", None, Some("2023-01-01"), "/tmp/yang-cache/cisco/xe/1715/Cisco-IOS-XE-native.yang").unwrap();

        // Update count
        update_module_count(db, release_id).unwrap();

        // List releases
        let releases = list_releases(db).unwrap();
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].vendor, "cisco");
        assert_eq!(releases[0].module_count, 2);

        // List modules
        let modules = list_modules(db, release_id, None).unwrap();
        assert_eq!(modules.len(), 2);
        assert_eq!(modules[0].name, "Cisco-IOS-XE-native");
        assert_eq!(modules[1].name, "ietf-interfaces");

        // Query modules
        let filtered = list_modules(db, release_id, Some("ietf")).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "ietf-interfaces");

        // Delete release
        delete_release(db, release_id).unwrap();
        let releases = list_releases(db).unwrap();
        assert_eq!(releases.len(), 0);
    }

    #[test]
    fn test_cache_base() {
        let base = cache_base().unwrap();
        assert!(base.to_string_lossy().contains(".ccie-terminal"));
        assert!(base.to_string_lossy().contains("yang-cache"));
    }
}
