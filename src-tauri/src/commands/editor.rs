use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use super::AppState;
use std::path::{Path, PathBuf};
use std::fs;
use rusqlite::{Connection, OptionalExtension};

// =====================================================================
// Path-safety helper (final security review — Finding 2).
// =====================================================================
//
// `editor_create_file` / `editor_delete_file` / `editor_rename_file` /
// `editor_create_directory` previously accepted raw `String` paths and
// passed them straight to `fs::*` with no canonicalization or
// workspace-root containment check. That means a `../../etc/passwd`
// path or a symlink that points outside the workspace would happily be
// honored.
//
// The frontend (`FileContextMenu.tsx`) already knows the editor tab's
// `root_path`; we plumb that workspace root through and reject any
// candidate path that, after canonicalization, doesn't sit under it.
// Callers that omit the workspace fall back to the user's home
// directory — strictly more permissive than nothing, strictly less than
// "the entire filesystem".

/// Resolve the effective workspace root. Caller-supplied `workspace_root`
/// wins; otherwise fall back to `$HOME`. The returned path is fully
/// canonicalized — symlinks resolved, components like `.` / `..` removed.
fn effective_workspace_root(workspace_root: Option<&str>) -> Result<PathBuf, String> {
    let raw = match workspace_root {
        Some(r) if !r.is_empty() => PathBuf::from(r),
        _ => dirs::home_dir().ok_or_else(|| {
            "no workspace_root supplied and home dir unavailable".to_string()
        })?,
    };
    fs::canonicalize(&raw).map_err(|e| {
        format!("workspace_root {:?} could not be canonicalized: {e}", raw)
    })
}

/// Validate a candidate path against the workspace root.
///
/// Rules:
///   1. Establish the workspace root via `effective_workspace_root`.
///   2. Canonicalize the candidate. If the candidate doesn't exist yet
///      (e.g. for `editor_create_file`), canonicalize the deepest
///      existing ancestor and re-attach the unresolved tail; this
///      catches `../../tmp/x` (the `..` resolves first, escaping the
///      root) and `./symlink-to-/etc/foo` (the symlink resolves first,
///      escaping the root) without requiring the leaf to exist.
///   3. Reject if the canonicalized path doesn't have the workspace
///      root as a prefix.
///
/// Returns the canonicalized candidate path on success.
fn validate_path(
    candidate: &str,
    workspace_root: Option<&str>,
) -> Result<PathBuf, String> {
    if candidate.is_empty() {
        return Err("path is empty".to_string());
    }
    let root = effective_workspace_root(workspace_root)?;
    let raw = PathBuf::from(candidate);

    // Walk upwards from the candidate until we find an ancestor that
    // exists, canonicalize that, then push the unresolved suffix back.
    // This handles "create a new file under an existing directory"
    // without forcing the file to already exist on disk.
    let (existing_ancestor, suffix) = {
        let mut probe = raw.clone();
        let mut suffix = PathBuf::new();
        loop {
            if probe.exists() {
                break (probe, suffix);
            }
            let leaf = match probe.file_name() {
                Some(n) => n.to_owned(),
                None => return Err(format!("path has no canonicalizable ancestor: {candidate}")),
            };
            let parent = match probe.parent() {
                Some(p) => p.to_path_buf(),
                None => return Err(format!("path has no canonicalizable ancestor: {candidate}")),
            };
            // Prepend `leaf` to the suffix (we walked one level up). Use
            // join+iteration rather than `push(empty_path)` because the
            // latter introduces a trailing separator that breaks fs::write.
            let mut new_suffix = PathBuf::from(&leaf);
            for component in suffix.iter() {
                new_suffix.push(component);
            }
            suffix = new_suffix;
            if parent.as_os_str().is_empty() {
                return Err(format!("path has no existing ancestor: {candidate}"));
            }
            probe = parent;
        }
    };
    let canon_ancestor = fs::canonicalize(&existing_ancestor).map_err(|e| {
        format!("could not canonicalize ancestor {:?}: {e}", existing_ancestor)
    })?;
    let canon = if suffix.as_os_str().is_empty() {
        canon_ancestor
    } else {
        canon_ancestor.join(suffix)
    };

    // Containment check.
    if !canon.starts_with(&root) {
        return Err(format!(
            "path {:?} resolves outside workspace root {:?}",
            canon, root
        ));
    }
    Ok(canon)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EditorFile {
    pub id: String,
    pub tab_id: String,
    pub file_path: String,
    pub content: String,
    pub language: String,
    pub is_dirty: bool,
    pub cursor_position: Option<String>, // JSON: {line, column}
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum FileNodeType {
    File,
    Directory,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileNode {
    pub path: String,
    pub name: String,
    pub node_type: FileNodeType,
    pub children: Option<Vec<FileNode>>,
}

const EDITOR_MODE_FLAG_KEY: &str = "ccie_editor_mode";
const DEFAULT_EDITOR_MODE: &str = "monaco";

fn ensure_app_flags_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_flags (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
    .map_err(|error| format!("Failed to ensure app_flags: {error}"))
}

pub(crate) fn load_editor_mode(conn: &Connection) -> Result<String, String> {
    ensure_app_flags_table(conn)?;
    let stored = conn
        .query_row(
            "SELECT value FROM app_flags WHERE key = ?1",
            rusqlite::params![EDITOR_MODE_FLAG_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read editor mode: {error}"))?;

    Ok(match stored.as_deref() {
        Some("zed") => "zed".to_string(),
        Some("monaco") | None => DEFAULT_EDITOR_MODE.to_string(),
        Some(_) => DEFAULT_EDITOR_MODE.to_string(),
    })
}

fn store_editor_mode(conn: &Connection, mode: &str) -> Result<(), String> {
    if !matches!(mode, "monaco" | "zed") {
        return Err(format!("unsupported editor mode: {mode}"));
    }

    ensure_app_flags_table(conn)?;
    conn.execute(
        "INSERT OR REPLACE INTO app_flags(key, value) VALUES (?1, ?2)",
        rusqlite::params![EDITOR_MODE_FLAG_KEY, mode],
    )
    .map_err(|error| format!("Failed to save editor mode: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn editor_mode_get(state: State<'_, AppState>) -> Result<String, String> {
    let conn = state.db.lock();
    load_editor_mode(&conn)
}

#[tauri::command]
pub fn editor_mode_set(
    state: State<'_, AppState>,
    mode: String,
) -> Result<(), String> {
    let conn = state.db.lock();
    store_editor_mode(&conn, &mode)
}

pub const EDITOR_BUFFER_CHANGED_EVENT: &str = "editor-buffer-changed";

fn require_editor_buffer_id(buffer_id: &str) -> Result<(), String> {
    if buffer_id.trim().is_empty() {
        Err("buffer_id must not be empty".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn editor_buffer_register(
    state: State<'_, AppState>,
    seed: crate::editor::EditorBufferSeed,
) -> Result<crate::editor::EditorBufferSnapshot, String> {
    require_editor_buffer_id(&seed.buffer_id)?;
    Ok(state.editor_buffer_manager.register(seed))
}

#[tauri::command]
pub fn editor_buffer_get(
    state: State<'_, AppState>,
    buffer_id: String,
) -> Result<crate::editor::EditorBufferSnapshot, String> {
    require_editor_buffer_id(&buffer_id)?;
    state
        .editor_buffer_manager
        .get(&buffer_id)
        .ok_or_else(|| format!("editor buffer not registered: {buffer_id}"))
}

#[tauri::command]
pub fn editor_buffer_update(
    app: AppHandle,
    state: State<'_, AppState>,
    buffer_id: String,
    base_revision: u64,
    content: String,
    language: String,
    dirty: bool,
    source_id: String,
) -> Result<crate::editor::EditorBufferUpdateResult, String> {
    require_editor_buffer_id(&buffer_id)?;
    let result = state
        .editor_buffer_manager
        .update(
            &buffer_id,
            base_revision,
            content,
            language,
            dirty,
            source_id,
        )
        .ok_or_else(|| format!("editor buffer not registered: {buffer_id}"))?;
    if let crate::editor::EditorBufferUpdateResult::Applied { snapshot } = &result {
        if let Err(error) = app.emit(EDITOR_BUFFER_CHANGED_EVENT, snapshot) {
            tracing::warn!(%error, buffer_id, "failed to emit editor buffer update");
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn editor_buffer_mark_saved(
    app: AppHandle,
    state: State<'_, AppState>,
    buffer_id: String,
    revision: u64,
    source_id: String,
) -> Result<crate::editor::EditorBufferUpdateResult, String> {
    require_editor_buffer_id(&buffer_id)?;
    let result = state
        .editor_buffer_manager
        .mark_saved(&buffer_id, revision, source_id)
        .ok_or_else(|| format!("editor buffer not registered: {buffer_id}"))?;
    if let crate::editor::EditorBufferUpdateResult::Applied { snapshot } = &result {
        if let Err(error) = app.emit(EDITOR_BUFFER_CHANGED_EVENT, snapshot) {
            tracing::warn!(%error, buffer_id, "failed to emit editor buffer save");
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn editor_open_file(
    state: State<'_, AppState>,
    tab_id: String,
    file_path: String,
) -> Result<EditorFile, String> {
    tracing::info!(tab_id = %tab_id, file_path = %file_path, "Opening file in editor");

    // Read file from filesystem
    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    // Detect language from extension
    let language = detect_language(&file_path);

    // Update recent files
    let conn = state.db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO editor_recent_files (file_path, last_opened, language, line_count)
         VALUES (?, strftime('%s','now'), ?, ?)",
        (&file_path, &language, content.lines().count() as i64),
    ).map_err(|e| format!("Failed to update recent files: {}", e))?;

    // Update tab state
    conn.execute(
        "INSERT OR REPLACE INTO editor_tab_state (tab_id, file_path, language, is_dirty, updated_at)
         VALUES (?, ?, ?, 0, strftime('%s','now'))",
        (&tab_id, &file_path, &language),
    ).map_err(|e| format!("Failed to save editor state: {}", e))?;

    Ok(EditorFile {
        id: uuid::Uuid::new_v4().to_string(),
        tab_id,
        file_path,
        content,
        language,
        is_dirty: false,
        cursor_position: None,
        created_at: chrono::Utc::now().timestamp(),
        updated_at: chrono::Utc::now().timestamp(),
    })
}

#[tauri::command]
pub async fn editor_save_file(
    state: State<'_, AppState>,
    tab_id: String,
    file_path: String,
    content: String,
) -> Result<(), String> {
    tracing::info!(tab_id = %tab_id, file_path = %file_path, "Saving file");

    // Write to filesystem
    fs::write(&file_path, &content)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    // Update database state
    let conn = state.db.lock();
    conn.execute(
        "UPDATE editor_tab_state SET is_dirty = 0, updated_at = strftime('%s','now')
         WHERE tab_id = ?",
        [&tab_id],
    ).map_err(|e| format!("Failed to update state: {}", e))?;

    // Update recent files
    let language = detect_language(&file_path);
    conn.execute(
        "INSERT OR REPLACE INTO editor_recent_files (file_path, last_opened, language, line_count)
         VALUES (?, strftime('%s','now'), ?, ?)",
        (&file_path, &language, content.lines().count() as i64),
    ).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn editor_get_state(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Option<EditorFile>, String> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT file_path, language, cursor_line, cursor_column, is_dirty
         FROM editor_tab_state WHERE tab_id = ?"
    ).map_err(|e| e.to_string())?;

    let file = stmt.query_row([&tab_id], |row| {
        let file_path: String = row.get(0)?;
        let content = fs::read_to_string(&file_path).unwrap_or_default();
        Ok(EditorFile {
            id: uuid::Uuid::new_v4().to_string(),
            tab_id: tab_id.clone(),
            file_path,
            content,
            language: row.get(1)?,
            is_dirty: row.get::<_, i64>(4)? != 0,
            cursor_position: Some(format!("{{\"line\":{},\"column\":{}}}",
                row.get::<_, i64>(2)?, row.get::<_, i64>(3)?)),
            created_at: 0,
            updated_at: 0,
        })
    }).optional().map_err(|e| e.to_string())?;

    Ok(file)
}

#[tauri::command]
pub async fn editor_list_recent(
    state: State<'_, AppState>,
    limit: usize,
) -> Result<Vec<String>, String> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT file_path FROM editor_recent_files
         ORDER BY last_opened DESC LIMIT ?"
    ).map_err(|e| e.to_string())?;

    let paths = stmt.query_map([limit], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(paths)
}

#[tauri::command]
pub async fn editor_list_directory(
    path: String,
) -> Result<Vec<FileNode>, String> {
    tracing::info!(path = %path, "Listing directory");

    let path_obj = Path::new(&path);
    if !path_obj.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !path_obj.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(path_obj)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let entry_path = entry.path();
        let entry_name = entry.file_name().to_string_lossy().to_string();

        // Skip ignored patterns
        if should_ignore(&entry_name) {
            continue;
        }

        let node_type = if entry_path.is_dir() {
            FileNodeType::Directory
        } else {
            FileNodeType::File
        };

        entries.push(FileNode {
            path: entry_path.to_string_lossy().to_string(),
            name: entry_name,
            node_type,
            children: None,
        });
    }

    // Sort: directories first, then files (alphabetically)
    entries.sort_by(|a, b| {
        match (&a.node_type, &b.node_type) {
            (FileNodeType::Directory, FileNodeType::File) => std::cmp::Ordering::Less,
            (FileNodeType::File, FileNodeType::Directory) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

#[tauri::command]
pub async fn editor_get_home_directory() -> Result<String, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Failed to get home directory".to_string())?;
    Ok(home.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn editor_create_file(
    path: String,
    workspace_root: Option<String>,
) -> Result<(), String> {
    tracing::info!(path = %path, "Creating file");

    // SECURITY: validate against workspace root first.
    let safe = validate_path(&path, workspace_root.as_deref())?;

    // Create parent directories if needed
    if let Some(parent) = safe.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directories: {}", e))?;
    }

    // Create empty file
    fs::write(&safe, "")
        .map_err(|e| format!("Failed to create file: {}", e))
}

#[tauri::command]
pub async fn editor_delete_file(
    path: String,
    workspace_root: Option<String>,
) -> Result<(), String> {
    tracing::info!(path = %path, "Deleting file/directory");

    // SECURITY: validate against workspace root first.
    let safe = validate_path(&path, workspace_root.as_deref())?;

    if safe.is_dir() {
        fs::remove_dir_all(&safe)
    } else {
        fs::remove_file(&safe)
    }
    .map_err(|e| format!("Failed to delete: {}", e))
}

#[tauri::command]
pub async fn editor_rename_file(
    old_path: String,
    new_path: String,
    workspace_root: Option<String>,
) -> Result<(), String> {
    tracing::info!(old_path = %old_path, new_path = %new_path, "Renaming file");

    // SECURITY: validate BOTH source and destination against the workspace
    // root. A malicious caller might rename `legit.txt` -> `../../etc/x` to
    // smuggle a write outside the workspace.
    let src = validate_path(&old_path, workspace_root.as_deref())?;
    let dst = validate_path(&new_path, workspace_root.as_deref())?;

    fs::rename(&src, &dst)
        .map_err(|e| format!("Failed to rename: {}", e))
}

#[tauri::command]
pub async fn editor_file_exists(path: String) -> Result<bool, String> {
    Ok(std::path::PathBuf::from(path).exists())
}

#[tauri::command]
pub async fn editor_create_directory(
    path: String,
    workspace_root: Option<String>,
) -> Result<(), String> {
    tracing::info!(path = %path, "Creating directory");

    // SECURITY: validate against workspace root first.
    let safe = validate_path(&path, workspace_root.as_deref())?;

    fs::create_dir_all(&safe)
        .map_err(|e| format!("Failed to create directory: {}", e))
}

// =====================================================================
// IaC Studio file I/O (Phase A).
// =====================================================================
//
// The IaC Studio tab is created frontend-only (crypto.randomUUID + addTab,
// like topology tabs) and is NEVER persisted to the `tabs` table. The
// `editor_*` commands above write to `editor_tab_state`, whose `tab_id`
// has a FOREIGN KEY → tabs(id); reusing them from the Studio fails with
// "FOREIGN KEY constraint failed".
//
// These commands provide DB-free, workspace-scoped read/write for the
// Studio. They reuse `validate_path` (the same path-traversal guard) and
// `detect_language`, but touch no database.

#[derive(Debug, Serialize, Deserialize)]
pub struct IacStudioFile {
    pub file_path: String,
    pub content: String,
    pub language: String,
}

/// Read a file for the IaC Studio. Workspace-scoped via `validate_path`; no
/// DB writes. Returns the content plus a detected language id.
#[tauri::command]
pub async fn iac_studio_read_file(
    file_path: String,
    workspace_root: Option<String>,
) -> Result<IacStudioFile, String> {
    let safe = validate_path(&file_path, workspace_root.as_deref())?;
    let content = fs::read_to_string(&safe)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    let language = detect_language(&safe.to_string_lossy());
    Ok(IacStudioFile {
        file_path: safe.to_string_lossy().to_string(),
        content,
        language,
    })
}

/// Write a file for the IaC Studio. Workspace-scoped via `validate_path`; no
/// DB writes.
#[tauri::command]
pub async fn iac_studio_write_file(
    file_path: String,
    content: String,
    workspace_root: Option<String>,
) -> Result<(), String> {
    let safe = validate_path(&file_path, workspace_root.as_deref())?;
    if let Some(parent) = safe.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories: {}", e))?;
    }
    fs::write(&safe, &content)
        .map_err(|e| format!("Failed to write file: {}", e))
}

/// Check if a file/directory should be ignored
fn should_ignore(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | "__pycache__" | "target" | ".venv")
}

/// Detect programming language from file extension
fn detect_language(file_path: &str) -> String {
    let ext = Path::new(file_path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    match ext {
        "py" => "python",
        "js" => "javascript",
        "ts" => "typescript",
        "jsx" => "javascript",
        "tsx" => "typescript",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "tf" => "hcl",
        "md" => "markdown",
        "sh" | "bash" | "zsh" => "shell",
        "toml" => "toml",
        "xml" => "xml",
        "html" => "html",
        "css" => "css",
        "rs" => "rust",
        "go" => "go",
        _ => "plaintext",
    }.to_string()
}

#[cfg(test)]
mod iac_studio_tests {
    use super::*;
    use tempfile::TempDir;

    // The async commands are thin wrappers over validate_path + fs; exercise
    // the same logic synchronously via a tokio runtime to keep the test simple.
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().unwrap()
    }

    #[test]
    fn read_then_write_round_trips_within_workspace() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let file = dir.path().join("main.tf");
        std::fs::write(&file, "resource \"x\" {}\n").unwrap();
        let fp = file.to_string_lossy().to_string();

        let read = rt()
            .block_on(iac_studio_read_file(fp.clone(), Some(root.clone())))
            .expect("read should succeed");
        assert_eq!(read.content, "resource \"x\" {}\n");
        assert_eq!(read.language, "hcl");

        rt().block_on(iac_studio_write_file(
            fp.clone(),
            "resource \"y\" {}\n".to_string(),
            Some(root.clone()),
        ))
        .expect("write should succeed");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "resource \"y\" {}\n");
    }

    #[test]
    fn rejects_paths_outside_workspace() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        // A traversal that escapes the workspace must be rejected.
        let escape = dir.path().join("../../etc/hosts").to_string_lossy().to_string();
        let res = rt().block_on(iac_studio_read_file(escape, Some(root)));
        assert!(res.is_err(), "path outside workspace must be rejected");
    }

    #[test]
    fn write_creates_missing_parent_dirs_within_workspace() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let nested = dir.path().join(".github").join("workflows").join("terraform.yml");
        let fp = nested.to_string_lossy().to_string();

        rt().block_on(iac_studio_write_file(
            fp.clone(),
            "name: terraform\n".to_string(),
            Some(root.clone()),
        ))
        .expect("write should create parent dirs and succeed");

        assert_eq!(std::fs::read_to_string(&nested).unwrap(), "name: terraform\n");
    }
}

#[cfg(test)]
mod editor_mode_tests {
    use super::*;

    fn test_conn() -> Connection {
        Connection::open_in_memory().expect("open in-memory sqlite")
    }

    #[test]
    fn editor_mode_defaults_to_monaco() {
        let conn = test_conn();
        assert_eq!(load_editor_mode(&conn).unwrap(), "monaco");
    }

    #[test]
    fn editor_mode_round_trips_both_supported_values() {
        let conn = test_conn();
        store_editor_mode(&conn, "zed").unwrap();
        assert_eq!(load_editor_mode(&conn).unwrap(), "zed");
        store_editor_mode(&conn, "monaco").unwrap();
        assert_eq!(load_editor_mode(&conn).unwrap(), "monaco");
    }

    #[test]
    fn editor_mode_rejects_invalid_values_without_overwriting() {
        let conn = test_conn();
        store_editor_mode(&conn, "zed").unwrap();
        let error = store_editor_mode(&conn, "vim").unwrap_err();
        assert!(error.contains("unsupported editor mode"));
        assert_eq!(load_editor_mode(&conn).unwrap(), "zed");
    }

    #[test]
    fn editor_mode_degrades_corrupt_rows_to_monaco() {
        let conn = test_conn();
        ensure_app_flags_table(&conn).unwrap();
        conn.execute(
            "INSERT INTO app_flags(key, value) VALUES (?1, ?2)",
            rusqlite::params![EDITOR_MODE_FLAG_KEY, "unexpected"],
        )
        .unwrap();
        assert_eq!(load_editor_mode(&conn).unwrap(), "monaco");
    }

    #[test]
    fn editor_mode_supports_legacy_two_column_app_flags_table() {
        let conn = test_conn();
        conn.execute_batch(
            "CREATE TABLE app_flags (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )
        .unwrap();
        store_editor_mode(&conn, "zed").unwrap();
        assert_eq!(load_editor_mode(&conn).unwrap(), "zed");
    }
}
