//! Keyring abstraction. Production uses the OS keyring via the `keyring`
//! crate; tests use the in-memory implementation.

use crate::vault::errors::VaultError;
use crate::vault::keyring_ref::SERVICE;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

pub trait KeyringStore: Send + Sync {
    fn set(&self, key: &str, value: &[u8]) -> Result<(), VaultError>;
    fn get(&self, key: &str) -> Result<Vec<u8>, VaultError>;
    fn delete(&self, key: &str) -> Result<(), VaultError>;
}

/// OS-backed keyring (production). Stores ciphertext as base64 in the
/// platform's secure storage.
pub struct OsKeyringStore;

impl OsKeyringStore {
    pub fn new() -> Self {
        Self
    }
}

impl Default for OsKeyringStore {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyringStore for OsKeyringStore {
    fn set(&self, key: &str, value: &[u8]) -> Result<(), VaultError> {
        use base64::{engine::general_purpose, Engine as _};
        log::info!("[VAULT] Setting keyring entry: service={}, account={}", SERVICE, key);
        let entry =
            keyring::Entry::new(SERVICE, key).map_err(|e| {
                log::error!("[VAULT] Failed to create Entry: {}", e);
                VaultError::Keyring(e.to_string())
            })?;
        let encoded = general_purpose::STANDARD.encode(value);
        entry
            .set_password(&encoded)
            .map_err(|e| {
                log::error!("[VAULT] Failed to set_password: {}", e);
                VaultError::Keyring(e.to_string())
            })
    }

    fn get(&self, key: &str) -> Result<Vec<u8>, VaultError> {
        use base64::{engine::general_purpose, Engine as _};
        log::info!("[VAULT] Getting keyring entry: service={}, account={}", SERVICE, key);
        let entry =
            keyring::Entry::new(SERVICE, key).map_err(|e| {
                log::error!("[VAULT] Failed to create Entry: {}", e);
                VaultError::Keyring(e.to_string())
            })?;
        match entry.get_password() {
            Ok(s) => {
                log::info!("[VAULT] Successfully retrieved password");
                general_purpose::STANDARD
                    .decode(s.as_bytes())
                    .map_err(|e| VaultError::Keyring(e.to_string()))
            }
            Err(keyring::Error::NoEntry) => {
                log::warn!("[VAULT] Keyring entry not found (NoEntry)");
                Err(VaultError::KeyringMissing)
            }
            Err(e) => {
                log::error!("[VAULT] Failed to get_password: {}", e);
                Err(VaultError::Keyring(e.to_string()))
            }
        }
    }

    fn delete(&self, key: &str) -> Result<(), VaultError> {
        let entry =
            keyring::Entry::new(SERVICE, key).map_err(|e| VaultError::Keyring(e.to_string()))?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Err(VaultError::KeyringMissing),
            Err(e) => Err(VaultError::Keyring(e.to_string())),
        }
    }
}

/// Database-backed keyring store. Stores encrypted keys in SQLite instead
/// of macOS Keychain. Used as workaround for Tauri Keychain access issues.
///
/// Uses its own database connection to avoid deadlocks when vault operations
/// already hold the main connection lock.
pub struct DbKeyringStore {
    db: parking_lot::Mutex<rusqlite::Connection>,
}

impl DbKeyringStore {
    pub fn new(db_path: &std::path::Path) -> Result<Self, VaultError> {
        let conn = rusqlite::Connection::open(db_path)
            .map_err(|e| VaultError::Keyring(format!("Failed to open keyring db: {}", e)))?;

        // Enable WAL mode for better concurrency
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| VaultError::Keyring(format!("Failed to set WAL mode: {}", e)))?;

        Ok(Self {
            db: parking_lot::Mutex::new(conn),
        })
    }
}

impl KeyringStore for DbKeyringStore {
    fn set(&self, key: &str, value: &[u8]) -> Result<(), VaultError> {
        log::info!("[VAULT] [DB] Setting keyring entry: account={}", key);
        let db = self.db.lock();
        // Store as BLOB directly (no base64 encoding needed for BLOB type)
        db.execute(
            "INSERT INTO vault_keyring (account, value_blob, updated_at)
             VALUES (?1, ?2, unixepoch())
             ON CONFLICT(account) DO UPDATE SET value_blob = ?2, updated_at = unixepoch()",
            rusqlite::params![key, value],
        )
        .map_err(|e| VaultError::Keyring(format!("DB set failed: {}", e)))?;
        log::info!("[VAULT] [DB] Keyring entry stored successfully");
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Vec<u8>, VaultError> {
        log::info!("[VAULT] [DB] Getting keyring entry: account={}", key);
        let db = self.db.lock();
        let value: Vec<u8> = db
            .query_row(
                "SELECT value_blob FROM vault_keyring WHERE account = ?1",
                rusqlite::params![key],
                |r| r.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    log::warn!("[VAULT] [DB] Keyring entry not found");
                    VaultError::KeyringMissing
                }
                _ => VaultError::Keyring(format!("DB get failed: {}", e)),
            })?;
        log::info!("[VAULT] [DB] Successfully retrieved keyring entry");
        Ok(value)
    }

    fn delete(&self, key: &str) -> Result<(), VaultError> {
        log::info!("[VAULT] [DB] Deleting keyring entry: account={}", key);
        let db = self.db.lock();
        let rows = db
            .execute(
                "DELETE FROM vault_keyring WHERE account = ?1",
                rusqlite::params![key],
            )
            .map_err(|e| VaultError::Keyring(format!("DB delete failed: {}", e)))?;
        if rows == 0 {
            log::warn!("[VAULT] [DB] Keyring entry not found for deletion");
            return Err(VaultError::KeyringMissing);
        }
        log::info!("[VAULT] [DB] Keyring entry deleted successfully");
        Ok(())
    }
}

/// In-memory keyring backend used by the test suite. Keeps the real OS
/// keychain untouched.
#[derive(Clone, Default)]
pub struct InMemoryKeyringStore {
    inner: Arc<Mutex<HashMap<String, Vec<u8>>>>,
}

impl InMemoryKeyringStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl KeyringStore for InMemoryKeyringStore {
    fn set(&self, key: &str, value: &[u8]) -> Result<(), VaultError> {
        self.inner.lock().insert(key.to_string(), value.to_vec());
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Vec<u8>, VaultError> {
        self.inner
            .lock()
            .get(key)
            .cloned()
            .ok_or(VaultError::KeyringMissing)
    }

    fn delete(&self, key: &str) -> Result<(), VaultError> {
        self.inner
            .lock()
            .remove(key)
            .map(|_| ())
            .ok_or(VaultError::KeyringMissing)
    }
}
