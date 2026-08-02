//! Plan 14 — Vault Tauri commands.

use crate::commands::AppState;
use crate::vault::{EnvelopeDto, SecretDto, VaultError};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroizing;

fn to_str(e: VaultError) -> String {
    e.to_string()
}

#[tauri::command]
pub fn vault_list_envelopes(state: State<'_, AppState>) -> Result<Vec<EnvelopeDto>, String> {
    let db = state.db.lock();
    state.vault.store.list_envelopes(&db).map_err(to_str)
}

#[tauri::command]
pub fn vault_create_envelope(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
    passphrase: String,
) -> Result<EnvelopeDto, String> {
    log::info!("[VAULT] Creating envelope: name={}", name);
    let pp = Zeroizing::new(passphrase.into_bytes());
    let db = state.db.lock();
    let result = state
        .vault
        .store
        .create_envelope(&db, &name, description.as_deref(), pp);

    match &result {
        Ok(envelope) => log::info!("[VAULT] Envelope created successfully: id={}", envelope.id),
        Err(e) => log::error!("[VAULT] Failed to create envelope: {}", e),
    }

    result.map_err(to_str)
}

#[tauri::command]
pub fn vault_unlock(
    state: State<'_, AppState>,
    name: String,
    passphrase: String,
) -> Result<String, String> {
    let pp = Zeroizing::new(passphrase.into_bytes());
    let db = state.db.lock();
    state
        .vault
        .store
        .unlock_envelope(&db, &state.vault.lock, &name, pp)
        .map_err(to_str)
}

#[tauri::command]
pub fn vault_lock(state: State<'_, AppState>, envelope_id: String) -> Result<(), String> {
    let db = state.db.lock();
    state
        .vault
        .store
        .lock_envelope(&db, &state.vault.lock, &envelope_id, "manual")
        .map_err(to_str)
}

#[tauri::command]
pub fn vault_delete_envelope(
    state: State<'_, AppState>,
    envelope_id: String,
) -> Result<(), String> {
    let db = state.db.lock();
    state
        .vault
        .store
        .delete_envelope(&db, &envelope_id)
        .map_err(to_str)
}

#[tauri::command]
pub fn vault_add_secret(
    state: State<'_, AppState>,
    envelope_id: String,
    kind: String,
    label: String,
    plaintext: String,
    metadata_json: String,
) -> Result<SecretDto, String> {
    let metadata: HashMap<String, serde_json::Value> =
        serde_json::from_str(&metadata_json).unwrap_or_default();
    let pt = Zeroizing::new(plaintext.into_bytes());
    let db = state.db.lock();
    state
        .vault
        .store
        .add_secret(
            &db,
            &state.vault.lock,
            &envelope_id,
            &kind,
            &label,
            pt,
            metadata,
        )
        .map_err(to_str)
}

#[tauri::command]
pub fn vault_list_secrets(
    state: State<'_, AppState>,
    envelope_id: String,
) -> Result<Vec<SecretDto>, String> {
    let db = state.db.lock();
    state
        .vault
        .store
        .list_secrets(&db, &envelope_id)
        .map_err(to_str)
}

#[tauri::command]
pub fn vault_reveal_secret(
    state: State<'_, AppState>,
    secret_id: String,
) -> Result<String, String> {
    let db = state.db.lock();
    let pt = state
        .vault
        .store
        .read_secret(&db, &state.vault.lock, &secret_id)
        .map_err(to_str)?;
    // Move into a String — caller is responsible for clearing on the JS side.
    String::from_utf8(pt.to_vec()).map_err(|e| format!("non-utf8 secret: {e}"))
}

#[tauri::command]
pub fn vault_delete_secret(state: State<'_, AppState>, secret_id: String) -> Result<(), String> {
    let db = state.db.lock();
    state
        .vault
        .store
        .delete_secret(&db, &secret_id)
        .map_err(to_str)
}

#[tauri::command]
pub fn vault_rotate_secret(
    state: State<'_, AppState>,
    secret_id: String,
    new_plaintext: String,
) -> Result<(), String> {
    let pt = Zeroizing::new(new_plaintext.into_bytes());
    let db = state.db.lock();
    state
        .vault
        .store
        .rotate_secret(&db, &state.vault.lock, &secret_id, pt)
        .map_err(to_str)
}

#[tauri::command]
pub fn vault_unlocked_ids(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.vault.lock.unlocked_ids())
}

#[tauri::command]
pub fn vault_set_auto_unlock(
    state: State<'_, AppState>,
    envelope_id: String,
    enabled: bool,
    passphrase: Option<String>,
) -> Result<(), String> {
    let pp = passphrase.map(|p| Zeroizing::new(p.into_bytes()));
    let db = state.db.lock();
    state
        .vault
        .store
        .set_auto_unlock(&db, &state.vault.lock, &envelope_id, enabled, pp)
        .map_err(to_str)
}

#[tauri::command]
pub fn vault_idle_sweep(state: State<'_, AppState>, app: AppHandle) -> Result<Vec<String>, String> {
    let swept = state.vault.lock.sweep_idle();
    let db = state.db.lock();
    let mut envelope_ids = Vec::new();
    for (envelope_id, session_id) in swept {
        let _ = db.execute(
            "UPDATE vault_sessions
             SET locked_at = unixepoch(), reason = 'idle'
             WHERE id = ?1 AND locked_at IS NULL",
            rusqlite::params![session_id],
        );
        envelope_ids.push(envelope_id);
    }
    if !envelope_ids.is_empty() {
        let _ = app.emit("vault://auto-locked", &envelope_ids);
    }
    Ok(envelope_ids)
}

#[derive(serde::Serialize)]
pub struct VaultSessionRow {
    pub id: String,
    pub envelope_id: String,
    pub envelope_name: String,
    pub unlocked_at: i64,
    pub locked_at: Option<i64>,
    pub reason: Option<String>,
}

#[tauri::command]
pub fn vault_import_csv(
    state: State<'_, AppState>,
    envelope_id: String,
    csv_path: String,
    format: Option<String>,
    secure_delete_after: Option<bool>,
) -> Result<crate::vault::import::ImportResult, String> {
    use crate::vault::import::{import_csv, secure_delete, ImportFormat};
    let fmt = match format.as_deref() {
        Some("1password") => ImportFormat::OnePassword,
        Some("bitwarden") => ImportFormat::Bitwarden,
        _ => ImportFormat::Auto,
    };
    let path = std::path::PathBuf::from(&csv_path);
    let db = state.db.lock();
    let result = import_csv(
        &db,
        &state.vault.lock,
        &state.vault.store,
        &envelope_id,
        &path,
        fmt,
    )
    .map_err(to_str)?;
    drop(db);
    if secure_delete_after.unwrap_or(false) {
        let _ = secure_delete(&path);
    }
    Ok(result)
}

#[tauri::command]
pub fn vault_audit_list(
    state: State<'_, AppState>,
    envelope_id: Option<String>,
    since: Option<i64>,
    limit: Option<u32>,
) -> Result<Vec<VaultSessionRow>, String> {
    let limit = limit.unwrap_or(200).min(2000);
    let since = since.unwrap_or(0);
    let db = state.db.lock();
    let sql = if envelope_id.is_some() {
        "SELECT s.id, s.envelope_id, e.name, s.unlocked_at, s.locked_at, s.reason
         FROM vault_sessions s
         LEFT JOIN vault_envelopes e ON e.id = s.envelope_id
         WHERE s.envelope_id = ?1 AND s.unlocked_at >= ?2
         ORDER BY s.unlocked_at DESC LIMIT ?3"
    } else {
        "SELECT s.id, s.envelope_id, e.name, s.unlocked_at, s.locked_at, s.reason
         FROM vault_sessions s
         LEFT JOIN vault_envelopes e ON e.id = s.envelope_id
         WHERE s.unlocked_at >= ?2
         ORDER BY s.unlocked_at DESC LIMIT ?3"
    };
    let mut stmt = db.prepare(sql).map_err(|e| e.to_string())?;
    let map_row = |r: &rusqlite::Row<'_>| -> rusqlite::Result<VaultSessionRow> {
        Ok(VaultSessionRow {
            id: r.get(0)?,
            envelope_id: r.get(1)?,
            envelope_name: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            unlocked_at: r.get(3)?,
            locked_at: r.get(4)?,
            reason: r.get(5)?,
        })
    };
    let rows: Vec<VaultSessionRow> = if let Some(eid) = envelope_id {
        stmt.query_map(rusqlite::params![eid, since, limit], map_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?
    } else {
        stmt.query_map(rusqlite::params!["", since, limit], map_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?
    };
    Ok(rows)
}
