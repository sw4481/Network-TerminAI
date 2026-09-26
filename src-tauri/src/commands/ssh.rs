use crate::commands::AppState;
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose, Engine as _};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::State;
use uuid::Uuid;

const ROOT_FOLDER_ID: &str = "root";
const MAX_FOLDER_DEPTH: usize = 8;
const MAX_TAGS: usize = 20;
const MAX_TAG_LEN: usize = 32;
const ACCENT_COLORS: &[&str] = &[
    "blue", "cyan", "green", "amber", "orange", "red", "purple", "pink",
];
const VENDORS: &[&str] = &["cisco", "juniper", "arista", "meraki", "generic"];
const SYNTAX_PROFILES: &[&str] = &["auto", "cisco", "junos", "arista", "generic"];

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct SshConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub user: Option<String>,
    pub port: Option<i64>,
    pub identity_file: Option<String>,
    pub password_encrypted: Option<String>,
    pub folder_id: String,
    pub tags: Vec<String>,
    pub accent_color: Option<String>,
    pub vendor: String,
    pub platform: String,
    pub syntax_highlighting_enabled: bool,
    pub syntax_profile: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct SshFolder {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct SaveSshConnectionRequest {
    pub name: String,
    pub host: String,
    pub user: Option<String>,
    pub port: Option<i64>,
    pub identity_file: Option<String>,
    pub password: Option<String>,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub accent_color: Option<String>,
    #[serde(default)]
    pub vendor: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub syntax_highlighting_enabled: Option<bool>,
    #[serde(default)]
    pub syntax_profile: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSshConnectionRequest {
    pub name: String,
    pub host: String,
    pub user: Option<String>,
    pub port: Option<i64>,
    pub identity_file: Option<String>,
    /// None keeps the current password; Some("") clears it.
    pub password: Option<String>,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub accent_color: Option<String>,
    #[serde(default)]
    pub vendor: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub syntax_highlighting_enabled: Option<bool>,
    #[serde(default)]
    pub syntax_profile: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateSshFolderRequest {
    pub parent_id: Option<String>,
    pub name: String,
    pub position: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSshFolderRequest {
    pub parent_id: String,
    pub name: String,
    pub position: i64,
}

fn encrypt_password(password: &str) -> String {
    let key = b"ccie-terminal-ssh-key-v1";
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

pub fn normalize_tags(tags: &[String]) -> Result<Vec<String>> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for raw in tags {
        let tag = raw.trim();
        if tag.is_empty() {
            continue;
        }
        if tag.chars().count() > MAX_TAG_LEN {
            return Err(anyhow!("tag exceeds {MAX_TAG_LEN} characters: {tag}"));
        }
        let folded = tag.to_lowercase();
        if seen.insert(folded) {
            normalized.push(tag.to_string());
            if normalized.len() > MAX_TAGS {
                return Err(anyhow!("a connection may have at most {MAX_TAGS} tags"));
            }
        }
    }
    Ok(normalized)
}

fn normalize_accent(raw: Option<&str>) -> Result<Option<String>> {
    let Some(raw) = raw else { return Ok(None) };
    let value = raw.trim().to_lowercase();
    if value.is_empty() {
        return Ok(None);
    }
    if !ACCENT_COLORS.contains(&value.as_str()) {
        return Err(anyhow!("unsupported accent color: {value}"));
    }
    Ok(Some(value))
}

fn normalize_vendor(raw: Option<&str>) -> Result<Option<String>> {
    let Some(raw) = raw else { return Ok(None) };
    let value = raw.trim().to_lowercase();
    if !VENDORS.contains(&value.as_str()) {
        return Err(anyhow!("unsupported vendor: {value}"));
    }
    Ok(Some(value))
}

fn normalize_platform(raw: Option<&str>) -> Result<Option<String>> {
    let Some(raw) = raw else { return Ok(None) };
    let value = raw.trim().to_lowercase();
    if value.is_empty() || value.len() > 64 {
        return Err(anyhow!("platform must contain 1 to 64 characters"));
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err(anyhow!("platform contains unsupported characters"));
    }
    Ok(Some(value))
}

fn normalize_syntax_profile(raw: Option<&str>) -> Result<Option<String>> {
    let Some(raw) = raw else { return Ok(None) };
    let value = raw.trim().to_lowercase();
    if !SYNTAX_PROFILES.contains(&value.as_str()) {
        return Err(anyhow!("unsupported syntax profile: {value}"));
    }
    Ok(Some(value))
}

pub(crate) fn validate_connection_basics(
    name: &str,
    host: &str,
    port: i64,
) -> Result<(String, String)> {
    let name = name.trim();
    let host = host.trim();
    if name.is_empty() {
        return Err(anyhow!("name is required"));
    }
    if host.is_empty() {
        return Err(anyhow!("host is required"));
    }
    if !(1..=65535).contains(&port) {
        return Err(anyhow!("port must be between 1 and 65535"));
    }
    Ok((name.to_string(), host.to_string()))
}

fn validate_folder_exists(conn: &Connection, id: &str) -> Result<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM ssh_folders WHERE id = ?1)",
        params![id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(anyhow!("SSH folder not found: {id}"));
    }
    Ok(())
}

fn connection_from_row(row: &Row<'_>) -> rusqlite::Result<SshConnection> {
    let tags_json: String = row.get(8)?;
    Ok(SshConnection {
        id: row.get(0)?,
        name: row.get(1)?,
        host: row.get(2)?,
        user: row.get(3)?,
        port: row.get(4)?,
        identity_file: row.get(5)?,
        password_encrypted: row.get(6)?,
        folder_id: row.get(7)?,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        accent_color: row.get(9)?,
        vendor: row.get(10)?,
        platform: row.get(11)?,
        syntax_highlighting_enabled: row.get(12)?,
        syntax_profile: row.get(13)?,
        created_at: row.get(14)?,
        last_used_at: row.get(15)?,
    })
}

const CONNECTION_SELECT: &str =
    "SELECT id, name, host, user, port, identity_file, password_encrypted,
            folder_id, tags_json, accent_color, vendor, platform,
            syntax_highlighting_enabled, syntax_profile, created_at, last_used_at
       FROM ssh_connections";

pub(crate) fn get_connection_impl(conn: &Connection, id: &str) -> Result<SshConnection> {
    conn.query_row(
        &format!("{CONNECTION_SELECT} WHERE id = ?1"),
        params![id],
        connection_from_row,
    )
    .map_err(Into::into)
}

pub fn save_connection_impl(
    conn: &Connection,
    request: SaveSshConnectionRequest,
) -> Result<SshConnection> {
    let port = request.port.unwrap_or(22);
    let (name, host) = validate_connection_basics(&request.name, &request.host, port)?;
    let folder_was_set = request.folder_id.is_some();
    let folder_id = request
        .folder_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or(ROOT_FOLDER_ID)
        .to_string();
    validate_folder_exists(conn, &folder_id)?;
    let tags_were_set = request.tags.is_some();
    let tags = normalize_tags(request.tags.as_deref().unwrap_or(&[]))?;
    let tags_json = serde_json::to_string(&tags)?;
    let accent_was_set = request.accent_color.is_some();
    let accent = normalize_accent(request.accent_color.as_deref())?;
    let vendor_was_set = request.vendor.is_some();
    let vendor = normalize_vendor(request.vendor.as_deref())?.unwrap_or_else(|| "generic".into());
    let platform_was_set = request.platform.is_some();
    let platform =
        normalize_platform(request.platform.as_deref())?.unwrap_or_else(|| "generic".into());
    let syntax_enabled_was_set = request.syntax_highlighting_enabled.is_some();
    let syntax_enabled = request.syntax_highlighting_enabled.unwrap_or(true);
    let syntax_profile_was_set = request.syntax_profile.is_some();
    let syntax_profile = normalize_syntax_profile(request.syntax_profile.as_deref())?
        .unwrap_or_else(|| "auto".into());
    let encrypted_password = request
        .password
        .as_ref()
        .map(|password| encrypt_password(password));

    conn.execute(
        "INSERT INTO ssh_connections
            (name, host, user, port, identity_file, password_encrypted,
             folder_id, tags_json, accent_color, vendor, platform,
             syntax_highlighting_enabled, syntax_profile)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(name) DO UPDATE SET
           host = excluded.host,
           user = excluded.user,
           port = excluded.port,
           identity_file = excluded.identity_file,
           password_encrypted = excluded.password_encrypted,
           folder_id = CASE WHEN ?14 THEN excluded.folder_id ELSE ssh_connections.folder_id END,
           tags_json = CASE WHEN ?15 THEN excluded.tags_json ELSE ssh_connections.tags_json END,
           accent_color = CASE WHEN ?16 THEN excluded.accent_color ELSE ssh_connections.accent_color END,
           vendor = CASE WHEN ?17 THEN excluded.vendor ELSE ssh_connections.vendor END,
           platform = CASE WHEN ?18 THEN excluded.platform ELSE ssh_connections.platform END,
           syntax_highlighting_enabled = CASE WHEN ?19 THEN excluded.syntax_highlighting_enabled ELSE ssh_connections.syntax_highlighting_enabled END,
           syntax_profile = CASE WHEN ?20 THEN excluded.syntax_profile ELSE ssh_connections.syntax_profile END",
        params![
            name,
            host,
            request.user.as_deref().map(str::trim).filter(|v| !v.is_empty()),
            port,
            request.identity_file.as_deref().map(str::trim).filter(|v| !v.is_empty()),
            encrypted_password,
            folder_id,
            tags_json,
            accent,
            vendor,
            platform,
            syntax_enabled,
            syntax_profile,
            folder_was_set,
            tags_were_set,
            accent_was_set,
            vendor_was_set,
            platform_was_set,
            syntax_enabled_was_set,
            syntax_profile_was_set,
        ],
    )?;

    let id: String = conn.query_row(
        "SELECT id FROM ssh_connections WHERE name = ?1",
        params![request.name.trim()],
        |row| row.get(0),
    )?;
    get_connection_impl(conn, &id)
}

pub fn update_connection_impl(
    conn: &Connection,
    id: &str,
    request: UpdateSshConnectionRequest,
) -> Result<SshConnection> {
    let port = request.port.unwrap_or(22);
    let (name, host) = validate_connection_basics(&request.name, &request.host, port)?;
    let folder_was_set = request.folder_id.is_some();
    let folder_id = request
        .folder_id
        .as_deref()
        .unwrap_or(ROOT_FOLDER_ID)
        .trim()
        .to_string();
    if folder_was_set {
        validate_folder_exists(conn, &folder_id)?;
    }
    let tags_were_set = request.tags.is_some();
    let tags_json =
        serde_json::to_string(&normalize_tags(request.tags.as_deref().unwrap_or(&[]))?)?;
    let accent_was_set = request.accent_color.is_some();
    let accent = normalize_accent(request.accent_color.as_deref())?;
    let vendor_was_set = request.vendor.is_some();
    let vendor = normalize_vendor(request.vendor.as_deref())?.unwrap_or_else(|| "generic".into());
    let platform_was_set = request.platform.is_some();
    let platform =
        normalize_platform(request.platform.as_deref())?.unwrap_or_else(|| "generic".into());
    let syntax_enabled_was_set = request.syntax_highlighting_enabled.is_some();
    let syntax_enabled = request.syntax_highlighting_enabled.unwrap_or(false);
    let syntax_profile_was_set = request.syntax_profile.is_some();
    let syntax_profile = normalize_syntax_profile(request.syntax_profile.as_deref())?
        .unwrap_or_else(|| "auto".into());
    let password_was_set = request.password.is_some();
    let password = request.password.and_then(|value| {
        if value.is_empty() {
            None
        } else {
            Some(encrypt_password(&value))
        }
    });

    let changed = conn.execute(
        "UPDATE ssh_connections SET
           name = ?1, host = ?2, user = ?3, port = ?4, identity_file = ?5,
           password_encrypted = CASE WHEN ?6 THEN ?7 ELSE password_encrypted END,
           folder_id = CASE WHEN ?8 THEN ?9 ELSE folder_id END,
           tags_json = CASE WHEN ?10 THEN ?11 ELSE tags_json END,
           accent_color = CASE WHEN ?12 THEN ?13 ELSE accent_color END,
           vendor = CASE WHEN ?14 THEN ?15 ELSE vendor END,
           platform = CASE WHEN ?16 THEN ?17 ELSE platform END,
           syntax_highlighting_enabled = CASE WHEN ?18 THEN ?19 ELSE syntax_highlighting_enabled END,
           syntax_profile = CASE WHEN ?20 THEN ?21 ELSE syntax_profile END
         WHERE id = ?22",
        params![
            name,
            host,
            request
                .user
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty()),
            port,
            request
                .identity_file
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty()),
            password_was_set,
            password,
            folder_was_set,
            folder_id,
            tags_were_set,
            tags_json,
            accent_was_set,
            accent,
            vendor_was_set,
            vendor,
            platform_was_set,
            platform,
            syntax_enabled_was_set,
            syntax_enabled,
            syntax_profile_was_set,
            syntax_profile,
            id,
        ],
    )?;
    if changed == 0 {
        return Err(anyhow!("SSH connection not found: {id}"));
    }
    get_connection_impl(conn, id)
}

pub(crate) fn normalize_folder_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err(anyhow!("folder name must contain 1 to 64 characters"));
    }
    Ok(name.to_string())
}

fn folder_depth(conn: &Connection, id: &str) -> Result<usize> {
    validate_folder_exists(conn, id)?;
    let depth: i64 = conn.query_row(
        "WITH RECURSIVE ancestors(id, parent_id, depth) AS (
           SELECT id, parent_id, 0 FROM ssh_folders WHERE id = ?1
           UNION ALL
           SELECT f.id, f.parent_id, ancestors.depth + 1
             FROM ssh_folders f JOIN ancestors ON f.id = ancestors.parent_id
         ) SELECT MAX(depth) FROM ancestors",
        params![id],
        |row| row.get(0),
    )?;
    Ok(depth as usize)
}

fn folder_subtree_height(conn: &Connection, id: &str) -> Result<usize> {
    validate_folder_exists(conn, id)?;
    let height: i64 = conn.query_row(
        "WITH RECURSIVE descendants(id, depth) AS (
           SELECT id, 0 FROM ssh_folders WHERE id = ?1
           UNION ALL
           SELECT f.id, descendants.depth + 1
             FROM ssh_folders f JOIN descendants ON f.parent_id = descendants.id
         ) SELECT MAX(depth) FROM descendants",
        params![id],
        |row| row.get(0),
    )?;
    Ok(height as usize)
}

fn ensure_unique_sibling_name(
    conn: &Connection,
    parent_id: &str,
    name: &str,
    excluding_id: Option<&str>,
) -> Result<()> {
    let duplicate: bool = conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM ssh_folders
            WHERE parent_id = ?1 AND lower(name) = lower(?2)
              AND (?3 IS NULL OR id <> ?3)
         )",
        params![parent_id, name, excluding_id],
        |row| row.get(0),
    )?;
    if duplicate {
        return Err(anyhow!("a folder named '{name}' already exists here"));
    }
    Ok(())
}

pub fn create_folder_impl(conn: &Connection, request: CreateSshFolderRequest) -> Result<SshFolder> {
    let parent_id = request
        .parent_id
        .as_deref()
        .unwrap_or(ROOT_FOLDER_ID)
        .trim();
    let name = normalize_folder_name(&request.name)?;
    validate_folder_exists(conn, parent_id)?;
    if folder_depth(conn, parent_id)? >= MAX_FOLDER_DEPTH {
        return Err(anyhow!(
            "SSH folders support at most {MAX_FOLDER_DEPTH} nested levels"
        ));
    }
    ensure_unique_sibling_name(conn, parent_id, &name, None)?;
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO ssh_folders(id, parent_id, name, position) VALUES (?1, ?2, ?3, ?4)",
        params![id, parent_id, name, request.position.unwrap_or(0)],
    )?;
    get_folder_impl(conn, &id)
}

fn get_folder_impl(conn: &Connection, id: &str) -> Result<SshFolder> {
    conn.query_row(
        "SELECT id, parent_id, name, position, created_at, updated_at FROM ssh_folders WHERE id = ?1",
        params![id],
        |row| {
            Ok(SshFolder {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                name: row.get(2)?,
                position: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    )
    .map_err(Into::into)
}

pub fn update_folder_impl(
    conn: &Connection,
    id: &str,
    request: UpdateSshFolderRequest,
) -> Result<SshFolder> {
    if id == ROOT_FOLDER_ID {
        return Err(anyhow!("the root SSH folder cannot be moved or renamed"));
    }
    let parent_id = request.parent_id.trim();
    if parent_id == id {
        return Err(anyhow!("a folder cannot be moved beneath itself"));
    }
    validate_folder_exists(conn, parent_id)?;
    let is_descendant: bool = conn.query_row(
        "WITH RECURSIVE descendants(id) AS (
           SELECT id FROM ssh_folders WHERE parent_id = ?1
           UNION ALL
           SELECT f.id FROM ssh_folders f JOIN descendants d ON f.parent_id = d.id
         ) SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)",
        params![id, parent_id],
        |row| row.get(0),
    )?;
    if is_descendant {
        return Err(anyhow!(
            "a folder cannot be moved beneath one of its descendants"
        ));
    }
    let resulting_depth = folder_depth(conn, parent_id)? + 1 + folder_subtree_height(conn, id)?;
    if resulting_depth > MAX_FOLDER_DEPTH {
        return Err(anyhow!(
            "SSH folders support at most {MAX_FOLDER_DEPTH} nested levels"
        ));
    }
    let name = normalize_folder_name(&request.name)?;
    ensure_unique_sibling_name(conn, parent_id, &name, Some(id))?;
    let changed = conn.execute(
        "UPDATE ssh_folders
            SET parent_id = ?1, name = ?2, position = ?3, updated_at = unixepoch()
          WHERE id = ?4",
        params![parent_id, name, request.position, id],
    )?;
    if changed == 0 {
        return Err(anyhow!("SSH folder not found: {id}"));
    }
    get_folder_impl(conn, id)
}

pub fn delete_folder_impl(conn: &mut Connection, id: &str) -> Result<()> {
    if id == ROOT_FOLDER_ID {
        return Err(anyhow!("the root SSH folder cannot be deleted"));
    }
    let parent_id: String = conn
        .query_row(
            "SELECT parent_id FROM ssh_folders WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| anyhow!("SSH folder not found: {id}"))?;
    let tx = conn.transaction()?;
    let mut occupied = {
        let mut statement =
            tx.prepare("SELECT lower(name) FROM ssh_folders WHERE parent_id = ?1 AND id <> ?2")?;
        let names = statement
            .query_map(params![parent_id, id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<HashSet<_>>>()?;
        names
    };
    let children = {
        let mut statement = tx.prepare(
            "SELECT id, name FROM ssh_folders WHERE parent_id = ?1 ORDER BY position, name COLLATE NOCASE",
        )?;
        let rows = statement
            .query_map(params![id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (child_id, child_name) in children {
        let mut reparented_name = child_name.clone();
        let mut suffix = 2usize;
        while occupied.contains(&reparented_name.to_lowercase()) {
            let suffix_text = format!(" ({suffix})");
            let keep = 64usize.saturating_sub(suffix_text.chars().count());
            let base = child_name.chars().take(keep).collect::<String>();
            reparented_name = format!("{base}{suffix_text}");
            suffix += 1;
        }
        occupied.insert(reparented_name.to_lowercase());
        tx.execute(
            "UPDATE ssh_folders
                SET parent_id = ?1, name = ?2, updated_at = unixepoch()
              WHERE id = ?3",
            params![parent_id, reparented_name, child_id],
        )?;
    }
    tx.execute(
        "UPDATE ssh_connections SET folder_id = ?1 WHERE folder_id = ?2",
        params![parent_id, id],
    )?;
    tx.execute("DELETE FROM ssh_folders WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(())
}

pub(crate) fn list_connections_impl(conn: &Connection) -> Result<Vec<SshConnection>> {
    let mut stmt = conn.prepare(&format!(
        "{CONNECTION_SELECT} ORDER BY last_used_at DESC NULLS LAST, name COLLATE NOCASE"
    ))?;
    let rows = stmt
        .query_map([], connection_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into);
    rows
}

#[tauri::command]
pub fn ssh_save_connection(
    state: State<'_, AppState>,
    request: SaveSshConnectionRequest,
) -> Result<SshConnection, String> {
    let db = state.db.lock();
    save_connection_impl(&db, request).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn ssh_update_connection(
    state: State<'_, AppState>,
    id: String,
    request: UpdateSshConnectionRequest,
) -> Result<SshConnection, String> {
    let db = state.db.lock();
    update_connection_impl(&db, &id, request).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn ssh_list_connections(state: State<'_, AppState>) -> Result<Vec<SshConnection>, String> {
    let db = state.db.lock();
    list_connections_impl(&db).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn ssh_get_connection(state: State<'_, AppState>, id: String) -> Result<SshConnection, String> {
    let db = state.db.lock();
    get_connection_impl(&db, &id).map_err(|error| error.to_string())
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
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn ssh_mark_used(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock();
    db.execute(
        "UPDATE ssh_connections SET last_used_at = unixepoch() WHERE id = ?1",
        [&id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn ssh_list_folders(state: State<'_, AppState>) -> Result<Vec<SshFolder>, String> {
    let db = state.db.lock();
    let mut stmt = db
        .prepare(
            "SELECT id, parent_id, name, position, created_at, updated_at
               FROM ssh_folders ORDER BY position, name COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let result = stmt
        .query_map([], |row| {
            Ok(SshFolder {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                name: row.get(2)?,
                position: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string());
    result
}

#[tauri::command]
pub fn ssh_create_folder(
    state: State<'_, AppState>,
    request: CreateSshFolderRequest,
) -> Result<SshFolder, String> {
    let db = state.db.lock();
    create_folder_impl(&db, request).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn ssh_update_folder(
    state: State<'_, AppState>,
    id: String,
    request: UpdateSshFolderRequest,
) -> Result<SshFolder, String> {
    let db = state.db.lock();
    update_folder_impl(&db, &id, request).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn ssh_delete_folder(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut db = state.db.lock();
    delete_folder_impl(&mut db, &id).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn organization_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE ssh_folders (
               id TEXT PRIMARY KEY,
               parent_id TEXT REFERENCES ssh_folders(id),
               name TEXT NOT NULL,
               position INTEGER NOT NULL DEFAULT 0,
               created_at INTEGER NOT NULL DEFAULT (unixepoch()),
               updated_at INTEGER NOT NULL DEFAULT (unixepoch())
             );
             CREATE UNIQUE INDEX sibling_name ON ssh_folders(COALESCE(parent_id, ''), lower(name));
             INSERT INTO ssh_folders(id, parent_id, name) VALUES ('root', NULL, 'All Devices');
             CREATE TABLE ssh_connections(id TEXT PRIMARY KEY, folder_id TEXT NOT NULL REFERENCES ssh_folders(id));",
        )
        .unwrap();
        conn
    }

    fn connection_db() -> Connection {
        let conn = organization_db();
        conn.execute_batch(
            "DROP TABLE ssh_connections;
             CREATE TABLE ssh_connections (
               id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
               name TEXT NOT NULL UNIQUE,
               host TEXT NOT NULL,
               user TEXT,
               port INTEGER,
               identity_file TEXT,
               password_encrypted TEXT,
               created_at INTEGER NOT NULL DEFAULT (unixepoch()),
               last_used_at INTEGER,
               folder_id TEXT NOT NULL DEFAULT 'root',
               tags_json TEXT NOT NULL DEFAULT '[]',
               accent_color TEXT,
               vendor TEXT NOT NULL DEFAULT 'generic',
               platform TEXT NOT NULL DEFAULT 'generic',
               syntax_highlighting_enabled INTEGER NOT NULL DEFAULT 0,
               syntax_profile TEXT NOT NULL DEFAULT 'auto'
             );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn tags_are_trimmed_and_case_insensitively_deduplicated() {
        let tags = vec![" Core ".into(), "core".into(), "WAN".into(), "".into()];
        assert_eq!(normalize_tags(&tags).unwrap(), vec!["Core", "WAN"]);
        assert_eq!(
            normalize_tags(&vec!["core".into(); 21]).unwrap(),
            vec!["core"]
        );
        assert!(normalize_tags(&["x".repeat(33)]).is_err());
        assert!(normalize_tags(&(0..21).map(|i| format!("t{i}")).collect::<Vec<_>>()).is_err());
    }

    #[test]
    fn folder_names_are_unique_per_sibling_and_cycles_are_rejected() {
        let conn = organization_db();
        let first = create_folder_impl(
            &conn,
            CreateSshFolderRequest {
                parent_id: None,
                name: "Sites".into(),
                position: None,
            },
        )
        .unwrap();
        assert!(create_folder_impl(
            &conn,
            CreateSshFolderRequest {
                parent_id: None,
                name: " sites ".into(),
                position: None
            },
        )
        .is_err());
        let child = create_folder_impl(
            &conn,
            CreateSshFolderRequest {
                parent_id: Some(first.id.clone()),
                name: "Raleigh".into(),
                position: None,
            },
        )
        .unwrap();
        assert!(update_folder_impl(
            &conn,
            &first.id,
            UpdateSshFolderRequest {
                parent_id: child.id,
                name: first.name,
                position: 0
            },
        )
        .unwrap_err()
        .to_string()
        .contains("descendant"));
    }

    #[test]
    fn deleting_a_folder_reparents_children_and_devices() {
        let mut conn = organization_db();
        let existing = create_folder_impl(
            &conn,
            CreateSshFolderRequest {
                parent_id: None,
                name: "Child".into(),
                position: None,
            },
        )
        .unwrap();
        let parent = create_folder_impl(
            &conn,
            CreateSshFolderRequest {
                parent_id: None,
                name: "Parent".into(),
                position: None,
            },
        )
        .unwrap();
        let child = create_folder_impl(
            &conn,
            CreateSshFolderRequest {
                parent_id: Some(parent.id.clone()),
                name: "Child".into(),
                position: None,
            },
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ssh_connections(id, folder_id) VALUES ('device', ?1)",
            params![parent.id],
        )
        .unwrap();
        delete_folder_impl(&mut conn, &parent.id).unwrap();
        assert_eq!(
            get_folder_impl(&conn, &child.id)
                .unwrap()
                .parent_id
                .as_deref(),
            Some("root")
        );
        assert_eq!(get_folder_impl(&conn, &child.id).unwrap().name, "Child (2)");
        assert_eq!(get_folder_impl(&conn, &existing.id).unwrap().name, "Child");
        let device_folder: String = conn
            .query_row(
                "SELECT folder_id FROM ssh_connections WHERE id = 'device'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(device_folder, "root");
    }

    #[test]
    fn moving_a_subtree_cannot_exceed_eight_levels() {
        let conn = organization_db();
        let mut deep_parent = "root".to_string();
        for index in 1..=7 {
            deep_parent = create_folder_impl(
                &conn,
                CreateSshFolderRequest {
                    parent_id: Some(deep_parent),
                    name: format!("Depth {index}"),
                    position: None,
                },
            )
            .unwrap()
            .id;
        }
        let subtree = create_folder_impl(
            &conn,
            CreateSshFolderRequest {
                parent_id: None,
                name: "Subtree".into(),
                position: None,
            },
        )
        .unwrap();
        create_folder_impl(
            &conn,
            CreateSshFolderRequest {
                parent_id: Some(subtree.id.clone()),
                name: "Leaf".into(),
                position: None,
            },
        )
        .unwrap();

        let error = update_folder_impl(
            &conn,
            &subtree.id,
            UpdateSshFolderRequest {
                parent_id: deep_parent,
                name: subtree.name,
                position: 0,
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("eight") || error.to_string().contains("8"));
    }

    #[test]
    fn legacy_save_callers_preserve_existing_inventory_metadata() {
        let conn = connection_db();
        let folder = create_folder_impl(
            &conn,
            CreateSshFolderRequest {
                parent_id: None,
                name: "Branches".into(),
                position: None,
            },
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ssh_connections
               (name, host, folder_id, tags_json, accent_color, vendor, platform)
             VALUES ('edge-1', '192.0.2.1', ?1, '[\"wan\"]', 'cyan', 'cisco', 'iosxe')",
            params![folder.id],
        )
        .unwrap();

        let saved = save_connection_impl(
            &conn,
            SaveSshConnectionRequest {
                name: "edge-1".into(),
                host: "192.0.2.2".into(),
                user: Some("netops".into()),
                port: None,
                identity_file: None,
                password: None,
                folder_id: None,
                tags: None,
                accent_color: None,
                vendor: None,
                platform: None,
                syntax_highlighting_enabled: None,
                syntax_profile: None,
            },
        )
        .unwrap();

        assert_eq!(saved.host, "192.0.2.2");
        assert_eq!(saved.folder_id, folder.id);
        assert_eq!(saved.tags, vec!["wan"]);
        assert_eq!(saved.accent_color.as_deref(), Some("cyan"));
        assert_eq!(saved.vendor, "cisco");
        assert_eq!(saved.platform, "iosxe");
        assert!(!saved.syntax_highlighting_enabled);
        assert_eq!(saved.syntax_profile, "auto");

        let new_device = save_connection_impl(
            &conn,
            SaveSshConnectionRequest {
                name: "edge-2".into(),
                host: "192.0.2.3".into(),
                user: None,
                port: None,
                identity_file: None,
                password: None,
                folder_id: None,
                tags: None,
                accent_color: None,
                vendor: None,
                platform: None,
                syntax_highlighting_enabled: None,
                syntax_profile: None,
            },
        )
        .unwrap();
        assert!(new_device.syntax_highlighting_enabled);
        assert_eq!(new_device.syntax_profile, "auto");
    }
}
