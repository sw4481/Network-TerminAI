use crate::commands::AppState;
use base64::{engine::general_purpose, Engine as _};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SshConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub user: Option<String>,
    pub port: Option<i64>,
    pub identity_file: Option<String>,
    pub password_encrypted: Option<String>,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct SaveSshConnectionRequest {
    pub name: String,
    pub host: String,
    pub user: Option<String>,
    pub port: Option<i64>,
    pub identity_file: Option<String>,
    pub password: Option<String>,
}

// Simple XOR encryption for passwords (not super secure but better than plaintext)
fn encrypt_password(password: &str) -> String {
    let key = b"ccie-terminal-ssh-key-v1"; // In production, use a proper key derivation
    let encrypted: Vec<u8> = password
        .bytes()
        .enumerate()
        .map(|(i, b)| b ^ key[i % key.len()])
        .collect();
    general_purpose::STANDARD.encode(&encrypted)
}

pub fn decrypt_password(encrypted: &str) -> Result<String, String> {
    let decoded = general_purpose::STANDARD
        .decode(encrypted)
        .map_err(|e| e.to_string())?;
    let key = b"ccie-terminal-ssh-key-v1";
    let decrypted: Vec<u8> = decoded
        .iter()
        .enumerate()
        .map(|(i, &b)| b ^ key[i % key.len()])
        .collect();
    String::from_utf8(decrypted).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ssh_save_connection(
    state: State<'_, AppState>,
    request: SaveSshConnectionRequest,
) -> Result<SshConnection, String> {
    let db = state.db.lock();
    let port = request.port.unwrap_or(22);

    // Encrypt password if provided
    let encrypted_password = request.password.as_ref().map(|p| encrypt_password(p));

    db.execute(
        "INSERT INTO ssh_connections (name, host, user, port, identity_file, password_encrypted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(name) DO UPDATE SET
           host = excluded.host,
           user = excluded.user,
           port = excluded.port,
           identity_file = excluded.identity_file,
           password_encrypted = excluded.password_encrypted",
        params![
            &request.name,
            &request.host,
            &request.user,
            port,
            &request.identity_file,
            &encrypted_password,
        ],
    )
    .map_err(|e| e.to_string())?;

    // Query by name to get the saved connection (works for both insert and update)
    let mut stmt = db
        .prepare(
            "SELECT id, name, host, user, port, identity_file, password_encrypted, created_at, last_used_at
             FROM ssh_connections
             WHERE name = ?1",
        )
        .map_err(|e| e.to_string())?;

    let connection = stmt
        .query_row([&request.name], |row| {
            Ok(SshConnection {
                id: row.get(0)?,
                name: row.get(1)?,
                host: row.get(2)?,
                user: row.get(3)?,
                port: row.get(4)?,
                identity_file: row.get(5)?,
                password_encrypted: row.get(6)?,
                created_at: row.get(7)?,
                last_used_at: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;

    Ok(connection)
}

#[derive(Debug, Deserialize)]
pub struct UpdateSshConnectionRequest {
    pub name: String,
    pub host: String,
    pub user: Option<String>,
    pub port: Option<i64>,
    pub identity_file: Option<String>,
    /// Plaintext password. `None` keeps the existing stored password unchanged
    /// (so the edit form doesn't have to re-collect it); `Some("")` clears it;
    /// any other value replaces it (re-encrypted).
    pub password: Option<String>,
}

/// Update an existing saved SSH connection in place by `id`, preserving its
/// `created_at`/`last_used_at` history. Unlike `ssh_save_connection` (which
/// upserts by `name`), this lets the user rename a connection and edit host /
/// user / port / identity file without losing history or creating a duplicate.
#[tauri::command]
pub fn ssh_update_connection(
    state: State<'_, AppState>,
    id: String,
    request: UpdateSshConnectionRequest,
) -> Result<SshConnection, String> {
    let db = state.db.lock();
    let port = request.port.unwrap_or(22);

    // Password semantics: None → leave the stored value alone; Some(_) →
    // replace (empty string clears it). We branch the SQL so a None request
    // never touches the password_encrypted column.
    match request.password {
        Some(pw) => {
            let encrypted = if pw.is_empty() {
                None
            } else {
                Some(encrypt_password(&pw))
            };
            db.execute(
                "UPDATE ssh_connections
                 SET name = ?1, host = ?2, user = ?3, port = ?4,
                     identity_file = ?5, password_encrypted = ?6
                 WHERE id = ?7",
                params![
                    &request.name,
                    &request.host,
                    &request.user,
                    port,
                    &request.identity_file,
                    &encrypted,
                    &id,
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        None => {
            db.execute(
                "UPDATE ssh_connections
                 SET name = ?1, host = ?2, user = ?3, port = ?4, identity_file = ?5
                 WHERE id = ?6",
                params![
                    &request.name,
                    &request.host,
                    &request.user,
                    port,
                    &request.identity_file,
                    &id,
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    let mut stmt = db
        .prepare(
            "SELECT id, name, host, user, port, identity_file, password_encrypted, created_at, last_used_at
             FROM ssh_connections
             WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;

    stmt.query_row([&id], |row| {
        Ok(SshConnection {
            id: row.get(0)?,
            name: row.get(1)?,
            host: row.get(2)?,
            user: row.get(3)?,
            port: row.get(4)?,
            identity_file: row.get(5)?,
            password_encrypted: row.get(6)?,
            created_at: row.get(7)?,
            last_used_at: row.get(8)?,
        })
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ssh_list_connections(state: State<'_, AppState>) -> Result<Vec<SshConnection>, String> {
    let db = state.db.lock();

    let mut stmt = db
        .prepare(
            "SELECT id, name, host, user, port, identity_file, password_encrypted, created_at, last_used_at
             FROM ssh_connections
             ORDER BY last_used_at DESC NULLS LAST, name ASC",
        )
        .map_err(|e| e.to_string())?;

    let connections = stmt
        .query_map([], |row| {
            Ok(SshConnection {
                id: row.get(0)?,
                name: row.get(1)?,
                host: row.get(2)?,
                user: row.get(3)?,
                port: row.get(4)?,
                identity_file: row.get(5)?,
                password_encrypted: row.get(6)?,
                created_at: row.get(7)?,
                last_used_at: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(connections)
}

#[tauri::command]
pub fn ssh_get_connection(state: State<'_, AppState>, id: String) -> Result<SshConnection, String> {
    let db = state.db.lock();

    let mut stmt = db
        .prepare(
            "SELECT id, name, host, user, port, identity_file, password_encrypted, created_at, last_used_at
             FROM ssh_connections
             WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;

    stmt.query_row([&id], |row| {
        Ok(SshConnection {
            id: row.get(0)?,
            name: row.get(1)?,
            host: row.get(2)?,
            user: row.get(3)?,
            port: row.get(4)?,
            identity_file: row.get(5)?,
            password_encrypted: row.get(6)?,
            created_at: row.get(7)?,
            last_used_at: row.get(8)?,
        })
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ssh_decrypt_password(
    _state: State<'_, AppState>,
    encrypted: String,
) -> Result<String, String> {
    decrypt_password(&encrypted)
}

#[tauri::command]
pub fn ssh_delete_connection(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock();
    db.execute("DELETE FROM ssh_connections WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn ssh_mark_used(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock();
    db.execute(
        "UPDATE ssh_connections SET last_used_at = unixepoch() WHERE id = ?1",
        [&id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
