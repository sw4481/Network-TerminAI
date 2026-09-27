//! Vault envelope + secret CRUD.
//!
//! Envelopes group secrets per site/customer. Each envelope has its own
//! Argon2id-derived AES-256-GCM key (held in `VaultLock` while unlocked).
//! Secret plaintext lives only in the OS keyring; the SQLite row carries
//! metadata + a stable `keyring_ref`.

use crate::vault::aead::{open as aead_open, seal as aead_seal};
use crate::vault::errors::VaultError;
use crate::vault::kdf::{derive_key, KdfParams};
use crate::vault::keyring_ref::{canary_key, secret_key};
use crate::vault::keyring_store::KeyringStore;
use crate::vault::lock::VaultLock;
use rand_core::{OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvelopeDto {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    #[serde(rename = "autoUnlock")]
    pub auto_unlock: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecretDto {
    pub id: String,
    #[serde(rename = "envelopeId")]
    pub envelope_id: String,
    pub kind: String,
    pub label: String,
    pub metadata: HashMap<String, serde_json::Value>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "lastUsedAt")]
    pub last_used_at: Option<i64>,
    #[serde(rename = "rotatesAt")]
    pub rotates_at: Option<i64>,
    #[serde(rename = "expiresAt")]
    pub expires_at: Option<i64>,
}

const VALID_KINDS: &[&str] = &[
    "password",
    "ssh_key",
    "api_token",
    "snmp_community",
    "netconf",
];

pub struct VaultStore {
    keyring: Arc<dyn KeyringStore>,
}

impl VaultStore {
    pub fn new(keyring: Arc<dyn KeyringStore>) -> Self {
        Self { keyring }
    }

    /// Create a new envelope. Generates a 16-byte salt, derives an AES key
    /// from `passphrase`, seals a 32-byte canary record under the key (AAD
    /// = envelope_id), stuffs the canary into the keyring, and inserts the
    /// row. Returns the public DTO; the derived key is **not** retained
    /// here — the caller must `unlock_envelope` to populate `VaultLock`.
    pub fn create_envelope(
        &self,
        db: &Connection,
        name: &str,
        description: Option<&str>,
        passphrase: Zeroizing<Vec<u8>>,
    ) -> Result<EnvelopeDto, VaultError> {
        if name.is_empty() {
            return Err(VaultError::InvalidInput("name is empty".into()));
        }
        let existing: Option<String> = db
            .query_row(
                "SELECT id FROM vault_envelopes WHERE name = ?1",
                params![name],
                |r| r.get(0),
            )
            .optional()?;
        if existing.is_some() {
            return Err(VaultError::EnvelopeNameTaken);
        }

        let id = Uuid::new_v4().simple().to_string();
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);
        let params = KdfParams::default();
        let key = derive_key(&passphrase, &salt, &params)?;

        // Canary: 32 random bytes, sealed with AAD = envelope_id.
        let mut canary_plaintext = [0u8; 32];
        OsRng.fill_bytes(&mut canary_plaintext);
        let canary_ct = aead_seal(&key, &canary_plaintext, id.as_bytes())?;
        log::info!(
            "[VAULT] Storing canary for envelope {}: key={}",
            name,
            canary_key(&id)
        );
        self.keyring.set(&canary_key(&id), &canary_ct)?;
        log::info!("[VAULT] Canary stored successfully");

        let kdf_json = serde_json::to_string(&serde_json::json!({
            "algo": "argon2id",
            "m": params.m_cost,
            "t": params.t_cost,
            "p": params.p_cost,
        }))?;

        db.execute(
            "INSERT INTO vault_envelopes (id, name, description, kdf_params_json, salt_blob)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, name, description, kdf_json, &salt[..]],
        )?;

        // Insert canary stub row so list_secrets / cleanup are coherent.
        let canary_secret_id = Uuid::new_v4().simple().to_string();
        db.execute(
            "INSERT INTO vault_secrets
               (id, envelope_id, kind, label, keyring_ref, metadata_json)
             VALUES (?1, ?2, 'password', '__canary__', ?3, '{\"__canary__\":true}')",
            params![canary_secret_id, id, canary_key(&id)],
        )?;

        self.get_envelope(db, &id)
    }

    pub fn get_envelope(&self, db: &Connection, id: &str) -> Result<EnvelopeDto, VaultError> {
        let row = db
            .query_row(
                "SELECT id, name, description, created_at, updated_at, auto_unlock
                 FROM vault_envelopes WHERE id = ?1",
                params![id],
                |r| {
                    Ok(EnvelopeDto {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        description: r.get(2)?,
                        created_at: r.get(3)?,
                        updated_at: r.get(4)?,
                        auto_unlock: r.get::<_, i64>(5)? != 0,
                    })
                },
            )
            .optional()?;
        row.ok_or(VaultError::EnvelopeNotFound)
    }

    pub fn list_envelopes(&self, db: &Connection) -> Result<Vec<EnvelopeDto>, VaultError> {
        let mut stmt = db.prepare(
            "SELECT id, name, description, created_at, updated_at, auto_unlock
             FROM vault_envelopes ORDER BY name ASC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(EnvelopeDto {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                    auto_unlock: r.get::<_, i64>(5)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn delete_envelope(&self, db: &Connection, id: &str) -> Result<(), VaultError> {
        // Delete keyring entries for every secret first.
        let mut stmt =
            db.prepare("SELECT keyring_ref FROM vault_secrets WHERE envelope_id = ?1")?;
        let refs: Vec<String> = stmt
            .query_map(params![id], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        for k in refs {
            // Tolerate already-missing entries.
            let _ = self.keyring.delete(&k);
        }
        db.execute("DELETE FROM vault_envelopes WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Attempt to unlock an envelope by name. On success, registers the
    /// derived key with `VaultLock` and inserts an audit row; returns the
    /// session_id. On failure, inserts an audit row with
    /// `reason='wrong_passphrase'` and returns `InvalidPassphrase`.
    pub fn unlock_envelope(
        &self,
        db: &Connection,
        lock: &VaultLock,
        name: &str,
        passphrase: Zeroizing<Vec<u8>>,
    ) -> Result<String, VaultError> {
        let row: Option<(String, Vec<u8>, String)> = db
            .query_row(
                "SELECT id, salt_blob, kdf_params_json FROM vault_envelopes WHERE name = ?1",
                params![name],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let (envelope_id, salt, kdf_json) = match row {
            Some(r) => r,
            // Generic error: do not leak whether the envelope exists.
            None => return Err(VaultError::InvalidPassphrase),
        };

        let kdf_params: serde_json::Value = serde_json::from_str(&kdf_json)?;
        let params = KdfParams {
            m_cost: kdf_params["m"].as_u64().unwrap_or(65536) as u32,
            t_cost: kdf_params["t"].as_u64().unwrap_or(3) as u32,
            p_cost: kdf_params["p"].as_u64().unwrap_or(1) as u32,
        };
        let key = derive_key(&passphrase, &salt, &params)?;

        // Verify against canary.
        let canary_ct = self.keyring.get(&canary_key(&envelope_id))?;
        if aead_open(&key, &canary_ct, envelope_id.as_bytes()).is_err() {
            // Audit the failed attempt.
            let _ = db.execute(
                "INSERT INTO vault_sessions (envelope_id, locked_at, reason)
                 VALUES (?1, unixepoch(), 'wrong_passphrase')",
                params![envelope_id],
            );
            return Err(VaultError::InvalidPassphrase);
        }

        let session_id = Uuid::new_v4().simple().to_string();
        db.execute(
            "INSERT INTO vault_sessions (id, envelope_id) VALUES (?1, ?2)",
            params![session_id, envelope_id],
        )?;
        lock.unlock(&envelope_id, key, session_id.clone());
        Ok(session_id)
    }

    pub fn lock_envelope(
        &self,
        db: &Connection,
        lock: &VaultLock,
        envelope_id: &str,
        reason: &str,
    ) -> Result<(), VaultError> {
        if let Some(session_id) = lock.lock(envelope_id) {
            db.execute(
                "UPDATE vault_sessions
                 SET locked_at = unixepoch(), reason = ?1
                 WHERE id = ?2 AND locked_at IS NULL",
                params![reason, session_id],
            )?;
        }
        Ok(())
    }

    pub fn add_secret(
        &self,
        db: &Connection,
        lock: &VaultLock,
        envelope_id: &str,
        kind: &str,
        label: &str,
        plaintext: Zeroizing<Vec<u8>>,
        metadata: HashMap<String, serde_json::Value>,
    ) -> Result<SecretDto, VaultError> {
        if !VALID_KINDS.contains(&kind) {
            return Err(VaultError::InvalidInput(format!("invalid kind: {kind}")));
        }
        if label.is_empty() {
            return Err(VaultError::InvalidInput("label is empty".into()));
        }
        let secret_id = Uuid::new_v4().simple().to_string();
        let kref = secret_key(envelope_id, &secret_id);

        let ct = lock
            .with_key(envelope_id, |key| {
                aead_seal(key, &plaintext, envelope_id.as_bytes())
            })
            .ok_or(VaultError::Locked)??;
        self.keyring.set(&kref, &ct)?;

        let metadata_json = serde_json::to_string(&metadata)?;
        db.execute(
            "INSERT INTO vault_secrets
               (id, envelope_id, kind, label, keyring_ref, metadata_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![secret_id, envelope_id, kind, label, kref, metadata_json],
        )?;

        self.get_secret_meta(db, &secret_id)
    }

    pub fn list_secrets(
        &self,
        db: &Connection,
        envelope_id: &str,
    ) -> Result<Vec<SecretDto>, VaultError> {
        let mut stmt = db.prepare(
            "SELECT id, envelope_id, kind, label, metadata_json,
                    created_at, last_used_at, rotates_at, expires_at
             FROM vault_secrets
             WHERE envelope_id = ?1 AND label != '__canary__'
             ORDER BY label ASC",
        )?;
        let rows = stmt
            .query_map(params![envelope_id], |r| {
                let meta_str: String = r.get(4)?;
                let meta: HashMap<String, serde_json::Value> =
                    serde_json::from_str(&meta_str).unwrap_or_default();
                Ok(SecretDto {
                    id: r.get(0)?,
                    envelope_id: r.get(1)?,
                    kind: r.get(2)?,
                    label: r.get(3)?,
                    metadata: meta,
                    created_at: r.get(5)?,
                    last_used_at: r.get(6)?,
                    rotates_at: r.get(7)?,
                    expires_at: r.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn get_secret_meta(&self, db: &Connection, secret_id: &str) -> Result<SecretDto, VaultError> {
        let row = db
            .query_row(
                "SELECT id, envelope_id, kind, label, metadata_json,
                        created_at, last_used_at, rotates_at, expires_at
                 FROM vault_secrets WHERE id = ?1",
                params![secret_id],
                |r| {
                    let meta_str: String = r.get(4)?;
                    let meta: HashMap<String, serde_json::Value> =
                        serde_json::from_str(&meta_str).unwrap_or_default();
                    Ok(SecretDto {
                        id: r.get(0)?,
                        envelope_id: r.get(1)?,
                        kind: r.get(2)?,
                        label: r.get(3)?,
                        metadata: meta,
                        created_at: r.get(5)?,
                        last_used_at: r.get(6)?,
                        rotates_at: r.get(7)?,
                        expires_at: r.get(8)?,
                    })
                },
            )
            .optional()?;
        row.ok_or(VaultError::SecretNotFound)
    }

    pub fn read_secret(
        &self,
        db: &Connection,
        lock: &VaultLock,
        secret_id: &str,
    ) -> Result<Zeroizing<Vec<u8>>, VaultError> {
        let row: Option<(String, String)> = db
            .query_row(
                "SELECT envelope_id, keyring_ref FROM vault_secrets WHERE id = ?1",
                params![secret_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (envelope_id, kref) = row.ok_or(VaultError::SecretNotFound)?;
        let ct = self.keyring.get(&kref)?;
        let pt = lock
            .with_key(&envelope_id, |key| {
                aead_open(key, &ct, envelope_id.as_bytes())
            })
            .ok_or(VaultError::Locked)??;
        // Bump last_used_at; a failure here is non-fatal.
        let _ = db.execute(
            "UPDATE vault_secrets SET last_used_at = unixepoch() WHERE id = ?1",
            params![secret_id],
        );
        Ok(pt)
    }

    pub fn delete_secret(&self, db: &Connection, secret_id: &str) -> Result<(), VaultError> {
        let kref: Option<String> = db
            .query_row(
                "SELECT keyring_ref FROM vault_secrets WHERE id = ?1",
                params![secret_id],
                |r| r.get(0),
            )
            .optional()?;
        let kref = kref.ok_or(VaultError::SecretNotFound)?;
        // Best-effort keyring delete first; tolerate already-missing.
        let _ = self.keyring.delete(&kref);
        db.execute(
            "DELETE FROM vault_secrets WHERE id = ?1",
            params![secret_id],
        )?;
        Ok(())
    }

    pub fn rotate_secret(
        &self,
        db: &Connection,
        lock: &VaultLock,
        secret_id: &str,
        new_plaintext: Zeroizing<Vec<u8>>,
    ) -> Result<(), VaultError> {
        let row: Option<(String, String)> = db
            .query_row(
                "SELECT envelope_id, keyring_ref FROM vault_secrets WHERE id = ?1",
                params![secret_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (envelope_id, kref) = row.ok_or(VaultError::SecretNotFound)?;
        let ct = lock
            .with_key(&envelope_id, |key| {
                aead_seal(key, &new_plaintext, envelope_id.as_bytes())
            })
            .ok_or(VaultError::Locked)??;
        self.keyring.set(&kref, &ct)?;
        Ok(())
    }

    /// Store passphrase for auto-unlock in keyring.
    /// Uses key: "ccie-terminal.vault.{envelope_id}.auto-passphrase"
    pub fn store_auto_unlock_passphrase(
        &self,
        envelope_id: &str,
        passphrase: &Zeroizing<Vec<u8>>,
    ) -> Result<(), VaultError> {
        let key = format!("ccie-terminal.vault.{}.auto-passphrase", envelope_id);
        self.keyring.set(&key, passphrase)?;
        Ok(())
    }

    /// Retrieve passphrase for auto-unlock from keyring.
    pub fn get_auto_unlock_passphrase(
        &self,
        envelope_id: &str,
    ) -> Result<Zeroizing<Vec<u8>>, VaultError> {
        let key = format!("ccie-terminal.vault.{}.auto-passphrase", envelope_id);
        let bytes = self.keyring.get(&key)?;
        Ok(Zeroizing::new(bytes))
    }

    /// Remove passphrase for auto-unlock from keyring.
    pub fn remove_auto_unlock_passphrase(&self, envelope_id: &str) -> Result<(), VaultError> {
        let key = format!("ccie-terminal.vault.{}.auto-passphrase", envelope_id);
        self.keyring.delete(&key).ok(); // Tolerate already-missing
        Ok(())
    }

    /// Toggle auto-unlock for an envelope. When enabling, verifies passphrase
    /// and stores it in keyring. When disabling, removes it from keyring.
    pub fn set_auto_unlock(
        &self,
        db: &Connection,
        lock: &VaultLock,
        envelope_id: &str,
        enabled: bool,
        passphrase: Option<Zeroizing<Vec<u8>>>,
    ) -> Result<(), VaultError> {
        if enabled {
            // Verify passphrase works by attempting unlock
            let passphrase = passphrase.ok_or_else(|| {
                VaultError::InvalidInput("passphrase required to enable auto-unlock".into())
            })?;

            // Get envelope name for unlock
            let name: String = db
                .query_row(
                    "SELECT name FROM vault_envelopes WHERE id = ?1",
                    params![envelope_id],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or(VaultError::EnvelopeNotFound)?;

            // Try to unlock to verify passphrase
            let _session_id = self.unlock_envelope(db, lock, &name, passphrase.clone())?;

            // Passphrase is valid, store it
            self.store_auto_unlock_passphrase(envelope_id, &passphrase)?;

            // Update DB
            db.execute(
                "UPDATE vault_envelopes SET auto_unlock = 1, updated_at = unixepoch() WHERE id = ?1",
                params![envelope_id],
            )?;

            log::info!("[VAULT] Auto-unlock enabled for envelope {}", envelope_id);
        } else {
            // Remove passphrase from keyring
            self.remove_auto_unlock_passphrase(envelope_id)?;

            // Update DB
            db.execute(
                "UPDATE vault_envelopes SET auto_unlock = 0, updated_at = unixepoch() WHERE id = ?1",
                params![envelope_id],
            )?;

            log::info!("[VAULT] Auto-unlock disabled for envelope {}", envelope_id);
        }

        Ok(())
    }
}
