//! Plan 14 — CSV import for vault envelopes.
//!
//! Supports the two common export formats:
//!
//! - **1Password**: `Title,Url,Username,Password,OTPAuth,Favorite status,Archived status,Tags,Notes`
//! - **Bitwarden**: `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp`
//!
//! All imported entries route through `VaultStore::add_secret`, so they
//! get the same Argon2id-derived AES key + AAD-bound AEAD seal as
//! manually-added secrets. CSV plaintext is loaded into a `Zeroizing`
//! buffer for the duration of import; the caller is responsible for
//! securely deleting the CSV file after.

use crate::vault::envelope::{SecretDto, VaultStore};
use crate::vault::errors::VaultError;
use crate::vault::lock::VaultLock;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use zeroize::Zeroizing;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportFormat {
    OnePassword,
    Bitwarden,
    Auto,
}

#[derive(Debug, Default, Serialize)]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
    #[serde(skip_serializing)]
    pub created: Vec<SecretDto>,
}

/// Import secrets into `envelope_id`. The envelope must already be
/// unlocked. Each row is added via `add_secret`, so the canary path,
/// AEAD seal, keyring, and SQLite metadata are all written through the
/// production CRUD pipeline — no shortcuts.
pub fn import_csv(
    db: &Connection,
    lock: &VaultLock,
    store: &VaultStore,
    envelope_id: &str,
    csv_path: &Path,
    format: ImportFormat,
) -> Result<ImportResult, VaultError> {
    let raw = std::fs::read(csv_path).map_err(|e| VaultError::Io(e.to_string()))?;
    // Wrap in Zeroizing so the in-memory buffer is wiped on drop.
    let raw = Zeroizing::new(raw);
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(raw.as_slice());

    let detected = match format {
        ImportFormat::Auto => detect_format(reader.headers().ok()),
        f => f,
    };

    let mut result = ImportResult::default();
    let header_indices = build_index(reader.headers().ok());

    for (i, rec) in reader.records().enumerate() {
        let row_num = i + 2; // header is row 1
        match rec {
            Ok(row) => match parse_row(detected, &header_indices, &row) {
                Some(parsed) => match store.add_secret(
                    db,
                    lock,
                    envelope_id,
                    &parsed.kind,
                    &parsed.label,
                    Zeroizing::new(parsed.plaintext.into_bytes()),
                    parsed.metadata,
                ) {
                    Ok(s) => {
                        result.imported += 1;
                        result.created.push(s);
                    }
                    Err(e) => {
                        result.skipped += 1;
                        result.errors.push(format!("row {row_num}: {e}"));
                    }
                },
                None => {
                    result.skipped += 1;
                }
            },
            Err(e) => {
                result.skipped += 1;
                result.errors.push(format!("row {row_num}: {e}"));
            }
        }
    }
    Ok(result)
}

/// Best-effort secure delete: overwrite with random bytes once, then
/// unlink. Note: SSDs may retain remnants via wear leveling. Documented
/// as advisory in `docs/SECURITY.md`.
pub fn secure_delete(path: &Path) -> Result<(), VaultError> {
    use rand_core::{OsRng, RngCore};
    if let Ok(meta) = std::fs::metadata(path) {
        if let Ok(mut f) = std::fs::OpenOptions::new().write(true).open(path) {
            use std::io::Write;
            let mut buf = vec![0u8; 4096];
            let mut remaining = meta.len() as i64;
            while remaining > 0 {
                let n = remaining.min(buf.len() as i64) as usize;
                OsRng.fill_bytes(&mut buf[..n]);
                let _ = f.write_all(&buf[..n]);
                remaining -= n as i64;
            }
            let _ = f.flush();
        }
    }
    std::fs::remove_file(path).map_err(|e| VaultError::Io(e.to_string()))
}

fn detect_format(headers: Option<&csv::StringRecord>) -> ImportFormat {
    let h = match headers {
        Some(h) => h,
        None => return ImportFormat::OnePassword,
    };
    let names: Vec<String> = h.iter().map(|s| s.to_lowercase()).collect();
    if names.iter().any(|n| n == "login_password") {
        ImportFormat::Bitwarden
    } else {
        ImportFormat::OnePassword
    }
}

struct ParsedRow {
    kind: String,
    label: String,
    plaintext: String,
    metadata: HashMap<String, serde_json::Value>,
}

fn build_index(headers: Option<&csv::StringRecord>) -> HashMap<String, usize> {
    let mut m = HashMap::new();
    if let Some(h) = headers {
        for (i, name) in h.iter().enumerate() {
            m.insert(name.to_lowercase(), i);
        }
    }
    m
}

fn col<'a>(idx: &HashMap<String, usize>, row: &'a csv::StringRecord, name: &str) -> Option<&'a str> {
    let pos = idx.get(name)?;
    row.get(*pos)
}

fn parse_row(
    format: ImportFormat,
    idx: &HashMap<String, usize>,
    row: &csv::StringRecord,
) -> Option<ParsedRow> {
    match format {
        ImportFormat::OnePassword => {
            let title = col(idx, row, "title").unwrap_or("").trim();
            let password = col(idx, row, "password").unwrap_or("").trim();
            let username = col(idx, row, "username").unwrap_or("").trim();
            let notes = col(idx, row, "notes").unwrap_or("");
            let url = col(idx, row, "url").unwrap_or("").trim();
            if title.is_empty() || password.is_empty() {
                return None;
            }
            let kind = if notes.contains("BEGIN OPENSSH PRIVATE KEY")
                || notes.contains("BEGIN RSA PRIVATE KEY")
            {
                "ssh_key"
            } else {
                "password"
            };
            let mut meta = HashMap::new();
            if !username.is_empty() {
                meta.insert("username".into(), serde_json::Value::String(username.into()));
            }
            if !url.is_empty() {
                meta.insert("url".into(), serde_json::Value::String(url.into()));
            }
            meta.insert("source".into(), serde_json::Value::String("1password_csv".into()));
            Some(ParsedRow {
                kind: kind.into(),
                label: title.into(),
                plaintext: password.into(),
                metadata: meta,
            })
        }
        ImportFormat::Bitwarden => {
            let name = col(idx, row, "name").unwrap_or("").trim();
            let password = col(idx, row, "login_password").unwrap_or("").trim();
            let username = col(idx, row, "login_username").unwrap_or("").trim();
            let totp = col(idx, row, "login_totp").unwrap_or("").trim();
            let uri = col(idx, row, "login_uri").unwrap_or("").trim();
            let notes = col(idx, row, "notes").unwrap_or("");
            if name.is_empty() || password.is_empty() {
                return None;
            }
            let kind = if notes.contains("BEGIN OPENSSH PRIVATE KEY")
                || notes.contains("BEGIN RSA PRIVATE KEY")
            {
                "ssh_key"
            } else {
                "password"
            };
            let mut meta = HashMap::new();
            if !username.is_empty() {
                meta.insert("username".into(), serde_json::Value::String(username.into()));
            }
            if !uri.is_empty() {
                meta.insert("url".into(), serde_json::Value::String(uri.into()));
            }
            if !totp.is_empty() {
                meta.insert("totp".into(), serde_json::Value::Bool(true));
            }
            meta.insert("source".into(), serde_json::Value::String("bitwarden_csv".into()));
            Some(ParsedRow {
                kind: kind.into(),
                label: name.into(),
                plaintext: password.into(),
                metadata: meta,
            })
        }
        ImportFormat::Auto => unreachable!("resolved earlier"),
    }
}
