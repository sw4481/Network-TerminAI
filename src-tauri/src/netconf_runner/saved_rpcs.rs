//! CRUD for saved NETCONF RPC templates.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::error::{NetconfError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedNetconfRpc {
    pub id: i64,
    pub name: String,
    pub rpc_xml: String,
    pub created_at: String,
    pub updated_at: String,
}

/// List all saved NETCONF RPCs ordered by name.
pub fn list(db: &Connection) -> Result<Vec<SavedNetconfRpc>> {
    let mut stmt = db.prepare(
        "SELECT id, name, rpc_xml, created_at, updated_at
         FROM netconf_saved_rpcs
         ORDER BY name ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(SavedNetconfRpc {
            id: row.get(0)?,
            name: row.get(1)?,
            rpc_xml: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| NetconfError::Database(e.to_string()))
}

/// Create or update a saved NETCONF RPC.
/// If id is Some, updates existing record. If None, creates new record.
pub fn upsert(db: &Connection, id: Option<i64>, name: &str, rpc_xml: &str) -> Result<SavedNetconfRpc> {
    let now = chrono::Utc::now().to_rfc3339();

    match id {
        Some(existing_id) => {
            // Update existing
            db.execute(
                "UPDATE netconf_saved_rpcs
                 SET name = ?1, rpc_xml = ?2, updated_at = ?3
                 WHERE id = ?4",
                params![name, rpc_xml, now, existing_id],
            )?;
            get_by_id(db, existing_id)
        }
        None => {
            // Create new
            db.execute(
                "INSERT INTO netconf_saved_rpcs (name, rpc_xml, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![name, rpc_xml, now, now],
            )?;
            let new_id = db.last_insert_rowid();
            get_by_id(db, new_id)
        }
    }
}

/// Delete a saved NETCONF RPC.
pub fn delete(db: &Connection, id: i64) -> Result<()> {
    db.execute("DELETE FROM netconf_saved_rpcs WHERE id = ?1", params![id])?;
    Ok(())
}

/// Get a saved NETCONF RPC by ID.
fn get_by_id(db: &Connection, id: i64) -> Result<SavedNetconfRpc> {
    let mut stmt = db.prepare(
        "SELECT id, name, rpc_xml, created_at, updated_at
         FROM netconf_saved_rpcs
         WHERE id = ?1",
    )?;
    let rpc = stmt.query_row([id], |row| {
        Ok(SavedNetconfRpc {
            id: row.get(0)?,
            name: row.get(1)?,
            rpc_xml: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    })?;
    Ok(rpc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_saved_rpcs_crud() {
        let temp_dir = tempfile::TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");
        let mut conn = crate::db::open_and_migrate(&db_path).unwrap();
        let db = &mut conn;

        // List should be empty initially
        let rpcs = list(db).unwrap();
        assert_eq!(rpcs.len(), 0);

        // Create
        let rpc1 = upsert(db, None, "Get running config", "<get-config><source><running/></source></get-config>").unwrap();
        assert_eq!(rpc1.name, "Get running config");

        let rpc2 = upsert(db, None, "Get interfaces", "<get><filter type=\"subtree\"><interfaces/></filter></get>").unwrap();

        // List
        let rpcs = list(db).unwrap();
        assert_eq!(rpcs.len(), 2);
        // Ordered by name
        assert_eq!(rpcs[0].name, "Get interfaces");
        assert_eq!(rpcs[1].name, "Get running config");

        // Update
        let updated = upsert(db, Some(rpc1.id), "Get running config (updated)", rpc1.rpc_xml.as_str()).unwrap();
        assert_eq!(updated.name, "Get running config (updated)");
        assert_eq!(updated.id, rpc1.id);

        // Delete
        delete(db, rpc2.id).unwrap();
        let rpcs = list(db).unwrap();
        assert_eq!(rpcs.len(), 1);
        assert_eq!(rpcs[0].id, rpc1.id);
    }
}
