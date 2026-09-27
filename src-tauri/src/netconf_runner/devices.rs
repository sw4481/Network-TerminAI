//! Saved NETCONF device CRUD with OS keychain integration.
//!
//! Passwords are stored in the OS keychain (macOS Keychain, Windows Credential
//! Manager, Linux Secret Service) via the `keyring` crate. The keychain key
//! is `netconf-device-{id}` where `{id}` is the SQLite row ID.
//!
//! If keychain operations fail (e.g., permission denied), we propagate the error
//! to the frontend rather than falling back to plaintext storage.

use crate::netconf_runner::error::{NetconfError, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// A saved NETCONF device with credentials stored in OS keychain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedDevice {
    pub id: i64,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Password is stored in keychain; this field is always null on read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    pub verify_host_key: bool,
    pub created_at: String,
}

/// List all saved devices (passwords excluded).
pub fn list_devices(db: &Connection) -> Result<Vec<SavedDevice>> {
    let mut stmt = db
        .prepare(
            "SELECT id, name, host, port, username, hostkey_verify, created_at
             FROM netconf_devices
             ORDER BY name ASC",
        )
        .map_err(|e| NetconfError::Database(e.to_string()))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(SavedDevice {
                id: row.get(0)?,
                name: row.get(1)?,
                host: row.get(2)?,
                port: row.get(3)?,
                username: row.get(4)?,
                password: None,
                verify_host_key: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| NetconfError::Database(e.to_string()))?;

    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| NetconfError::Database(e.to_string()))
}

/// Create a new saved device. Password is stored in keychain.
pub fn create_device(
    db: &Connection,
    name: &str,
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    verify_host_key: bool,
) -> Result<SavedDevice> {
    let now = chrono::Utc::now().to_rfc3339();
    let verify_int = if verify_host_key { 1 } else { 0 };

    db.execute(
        "INSERT INTO netconf_devices (name, host, port, username, hostkey_verify, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![name, host, port, username, verify_int, now],
    )
    .map_err(|e| NetconfError::Database(e.to_string()))?;

    let id = db.last_insert_rowid();
    set_password(id, password)?;

    Ok(SavedDevice {
        id,
        name: name.to_string(),
        host: host.to_string(),
        port,
        username: username.to_string(),
        password: None,
        verify_host_key,
        created_at: now,
    })
}

/// Delete a saved device. Also removes its password from the keychain.
pub fn delete_device(db: &Connection, id: i64) -> Result<()> {
    db.execute("DELETE FROM netconf_devices WHERE id = ?1", params![id])
        .map_err(|e| NetconfError::Database(e.to_string()))?;

    // Best-effort keychain cleanup — if the entry doesn't exist, that's fine.
    let _ = keyring::Entry::new("ccie-terminal", &format!("netconf-device-{id}"))
        .and_then(|e| e.delete_credential());

    Ok(())
}

/// Retrieve a device's password from the OS keychain.
pub fn get_password(id: i64) -> Result<String> {
    let key = format!("netconf-device-{id}");
    tracing::debug!("Attempting to retrieve password for key: {}", key);
    let entry = keyring::Entry::new("ccie-terminal", &key)
        .map_err(|e| NetconfError::Keychain(e.to_string()))?;
    let password = entry
        .get_password()
        .map_err(|e| {
            tracing::error!("Failed to get password for key {}: {}", key, e);
            NetconfError::Keychain(e.to_string())
        })?;
    tracing::debug!("Successfully retrieved password for key: {}", key);
    Ok(password)
}

/// Store a device's password in the OS keychain.
fn set_password(id: i64, password: &str) -> Result<()> {
    let key = format!("netconf-device-{id}");
    tracing::debug!("Attempting to store password for key: {}", key);
    let entry = keyring::Entry::new("ccie-terminal", &key)
        .map_err(|e| NetconfError::Keychain(e.to_string()))?;
    entry
        .set_password(password)
        .map_err(|e| {
            tracing::error!("Failed to set password for key {}: {}", key, e);
            NetconfError::Keychain(e.to_string())
        })?;
    tracing::info!("Successfully stored password for key: {}", key);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup_db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute(
            "CREATE TABLE netconf_devices (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                username TEXT NOT NULL,
                platform TEXT NOT NULL DEFAULT 'iosxe',
                hostkey_verify INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL DEFAULT 0
            )",
            [],
        )
        .unwrap();
        db
    }

    #[test]
    fn test_list_devices_empty() {
        let db = setup_db();
        let devices = list_devices(&db).unwrap();
        assert_eq!(devices.len(), 0);
    }

    #[test]
    fn test_create_and_list() {
        let db = setup_db();
        let dev = create_device(&db, "Lab CSR", "192.168.1.1", 830, "admin", "secret", false)
            .unwrap();
        assert_eq!(dev.name, "Lab CSR");
        assert_eq!(dev.host, "192.168.1.1");
        assert!(dev.password.is_none());

        let devices = list_devices(&db).unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].name, "Lab CSR");
    }

    #[test]
    fn test_password_roundtrip() {
        let db = setup_db();

        // Pre-cleanup: remove any stale keychain entry for ID 1
        let _ = keyring::Entry::new("ccie-terminal", "netconf-device-1")
            .and_then(|e| e.delete_credential());

        let dev = create_device(&db, "Test", "10.0.0.1", 830, "user", "pass123", true).unwrap();

        // Retrieve and verify
        let retrieved = get_password(dev.id);
        if retrieved.is_err() {
            // Cleanup and skip test if keyring isn't available (e.g., headless CI)
            eprintln!("Keyring not available, skipping password test: {:?}", retrieved.err());
            return;
        }
        assert_eq!(retrieved.unwrap(), "pass123");

        // Cleanup: delete the keychain entry
        let _ = keyring::Entry::new("ccie-terminal", &format!("netconf-device-{}", dev.id))
            .and_then(|e| e.delete_credential());
    }

    #[test]
    fn test_delete_device() {
        let db = setup_db();
        let dev = create_device(&db, "ToDelete", "10.0.0.2", 830, "admin", "pw", false).unwrap();
        assert_eq!(list_devices(&db).unwrap().len(), 1);

        delete_device(&db, dev.id).unwrap();
        assert_eq!(list_devices(&db).unwrap().len(), 0);

        // Password should be gone from keychain
        assert!(get_password(dev.id).is_err());
    }
}
