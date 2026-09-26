use super::AppState;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

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
        _ => dirs::home_dir()
            .ok_or_else(|| "no workspace_root supplied and home dir unavailable".to_string())?,
    };
    fs::canonicalize(&raw)
        .map_err(|e| format!("workspace_root {:?} could not be canonicalized: {e}", raw))
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
fn validate_path(candidate: &str, workspace_root: Option<&str>) -> Result<PathBuf, String> {
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
        format!(
            "could not canonicalize ancestor {:?}: {e}",
            existing_ancestor
        )
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

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct EditorSearchMatch {
    pub file_path: String,
    pub line: usize,
    pub column: usize,
    pub preview: String,
}

const EDITOR_SEARCH_PREVIEW_MAX_CHARS: usize = 160;
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
pub fn editor_mode_set(state: State<'_, AppState>, mode: String) -> Result<(), String> {
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
    cisco_platform: Option<String>,
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
            cisco_platform,
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
    let content =
        fs::read_to_string(&file_path).map_err(|e| format!("Failed to read file: {}", e))?;

    // Detect language from extension
    let language = detect_language(&file_path);

    // Update recent files
    let conn = state.db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO editor_recent_files (file_path, last_opened, language, line_count)
         VALUES (?, strftime('%s','now'), ?, ?)",
        (&file_path, &language, content.lines().count() as i64),
    )
    .map_err(|e| format!("Failed to update recent files: {}", e))?;

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
    fs::write(&file_path, &content).map_err(|e| format!("Failed to write file: {}", e))?;

    // Update database state
    let conn = state.db.lock();
    conn.execute(
        "UPDATE editor_tab_state SET is_dirty = 0, updated_at = strftime('%s','now')
         WHERE tab_id = ?",
        [&tab_id],
    )
    .map_err(|e| format!("Failed to update state: {}", e))?;

    // Update recent files
    let language = detect_language(&file_path);
    conn.execute(
        "INSERT OR REPLACE INTO editor_recent_files (file_path, last_opened, language, line_count)
         VALUES (?, strftime('%s','now'), ?, ?)",
        (&file_path, &language, content.lines().count() as i64),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn editor_get_state(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Option<EditorFile>, String> {
    let conn = state.db.lock();
    let mut stmt = conn
        .prepare(
            "SELECT file_path, language, cursor_line, cursor_column, is_dirty
         FROM editor_tab_state WHERE tab_id = ?",
        )
        .map_err(|e| e.to_string())?;

    let file = stmt
        .query_row([&tab_id], |row| {
            let file_path: String = row.get(0)?;
            let content = fs::read_to_string(&file_path).unwrap_or_default();
            Ok(EditorFile {
                id: uuid::Uuid::new_v4().to_string(),
                tab_id: tab_id.clone(),
                file_path,
                content,
                language: row.get(1)?,
                is_dirty: row.get::<_, i64>(4)? != 0,
                cursor_position: Some(format!(
                    "{{\"line\":{},\"column\":{}}}",
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?
                )),
                created_at: 0,
                updated_at: 0,
            })
        })
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(file)
}

#[tauri::command]
pub async fn editor_list_recent(
    state: State<'_, AppState>,
    limit: usize,
) -> Result<Vec<String>, String> {
    let conn = state.db.lock();
    let mut stmt = conn
        .prepare(
            "SELECT file_path FROM editor_recent_files
         ORDER BY last_opened DESC LIMIT ?",
        )
        .map_err(|e| e.to_string())?;

    let paths = stmt
        .query_map([limit], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(paths)
}

#[tauri::command]
pub async fn editor_list_directory(path: String) -> Result<Vec<FileNode>, String> {
    tracing::info!(path = %path, "Listing directory");

    let path_obj = Path::new(&path);
    if !path_obj.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !path_obj.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let mut entries = Vec::new();
    let read_dir =
        fs::read_dir(path_obj).map_err(|e| format!("Failed to read directory: {}", e))?;

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
    entries.sort_by(|a, b| match (&a.node_type, &b.node_type) {
        (FileNodeType::Directory, FileNodeType::File) => std::cmp::Ordering::Less,
        (FileNodeType::File, FileNodeType::Directory) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

/// Read-only workspace search. Filename patterns are comma-separated literal
/// names; each item may contain one `*` wildcard.
#[tauri::command]
pub fn editor_find_in_files(
    workspace_root: String,
    query: String,
    regex: bool,
    match_case: bool,
    whole_word: bool,
    file_pattern: Option<String>,
    max_results: usize,
) -> Result<Vec<EditorSearchMatch>, String> {
    if query.is_empty() {
        return Err("query must not be empty".to_string());
    }
    if max_results == 0 {
        return Err("max_results must be greater than zero".to_string());
    }
    if regex && whole_word {
        return Err("whole_word is unavailable for regex searches".to_string());
    }

    let expression = if regex {
        Some(
            regex::RegexBuilder::new(&query)
                .case_insensitive(!match_case)
                .build()
                .map_err(|error| format!("invalid regular expression: {error}"))?,
        )
    } else {
        None
    };
    let root = validate_path(&workspace_root, Some(&workspace_root))?;
    if !root.is_dir() {
        return Err(format!(
            "workspace_root is not a directory: {}",
            root.display()
        ));
    }
    let patterns: Vec<String> = file_pattern
        .as_deref()
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|pattern| !pattern.is_empty())
        .map(str::to_string)
        .collect();

    let mut matches = Vec::new();
    search_directory(
        &root,
        &root,
        &query,
        expression.as_ref(),
        match_case,
        whole_word,
        &patterns,
        &mut matches,
    )?;
    matches.sort_by(|left, right| {
        (&left.file_path, left.line, left.column).cmp(&(&right.file_path, right.line, right.column))
    });
    matches.truncate(max_results);
    Ok(matches)
}

fn search_directory(
    root: &Path,
    directory: &Path,
    query: &str,
    expression: Option<&regex::Regex>,
    match_case: bool,
    whole_word: bool,
    patterns: &[String],
    matches: &mut Vec<EditorSearchMatch>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Failed to read directory {}: {error}", directory.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read directory entry: {error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if should_ignore(&name) {
            continue;
        }

        let entry_path = entry.path();
        let safe = validate_path(&entry_path.to_string_lossy(), Some(&root.to_string_lossy()))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect {}: {error}", entry_path.display()))?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            search_directory(
                root, &safe, query, expression, match_case, whole_word, patterns, matches,
            )?;
            continue;
        }
        if !file_type.is_file() || !filename_matches(&name, patterns) {
            continue;
        }

        let content = match fs::read_to_string(&safe) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => continue,
            Err(error) => return Err(format!("Failed to read {}: {error}", safe.display())),
        };
        for (line_index, line) in content.lines().enumerate() {
            let ranges = match expression {
                Some(expression) => expression
                    .find_iter(line)
                    .map(|found| (found.start(), found.end()))
                    .collect(),
                None => literal_match_ranges(line, query, match_case),
            };
            for (start, end) in ranges {
                if whole_word && !is_whole_word(line, start, end) {
                    continue;
                }
                matches.push(EditorSearchMatch {
                    file_path: safe.to_string_lossy().to_string(),
                    line: line_index + 1,
                    column: line[..start].chars().count() + 1,
                    preview: bounded_search_preview(line, start, end),
                });
            }
        }
    }
    Ok(())
}

fn bounded_search_preview(line: &str, match_start: usize, match_end: usize) -> String {
    let characters: Vec<char> = line.chars().collect();
    if characters.len() <= EDITOR_SEARCH_PREVIEW_MAX_CHARS {
        return line.to_string();
    }

    let match_start = line[..match_start].chars().count();
    let match_end = line[..match_end].chars().count();
    let match_len = match_end - match_start;
    let (preview_start, preview_end) = if match_len >= EDITOR_SEARCH_PREVIEW_MAX_CHARS {
        (match_start, match_start + EDITOR_SEARCH_PREVIEW_MAX_CHARS)
    } else {
        let context = EDITOR_SEARCH_PREVIEW_MAX_CHARS - match_len;
        let mut preview_start = match_start.saturating_sub(context / 2);
        let preview_end = (preview_start + EDITOR_SEARCH_PREVIEW_MAX_CHARS).min(characters.len());
        preview_start = preview_end.saturating_sub(EDITOR_SEARCH_PREVIEW_MAX_CHARS);
        (preview_start, preview_end)
    };

    characters[preview_start..preview_end].iter().collect()
}

fn filename_matches(name: &str, patterns: &[String]) -> bool {
    patterns.is_empty()
        || patterns.iter().any(|pattern| {
            if let Some((prefix, suffix)) = pattern.split_once('*') {
                !suffix.contains('*') && name.starts_with(prefix) && name.ends_with(suffix)
            } else {
                name == pattern
            }
        })
}

fn literal_match_ranges(line: &str, query: &str, match_case: bool) -> Vec<(usize, usize)> {
    let line_chars: Vec<(usize, char)> = line.char_indices().collect();
    let query_chars: Vec<char> = query.chars().collect();
    let mut ranges = Vec::new();
    let mut start = 0;
    while start + query_chars.len() <= line_chars.len() {
        let matches = line_chars[start..start + query_chars.len()]
            .iter()
            .map(|(_, character)| character)
            .zip(&query_chars)
            .all(|(left, right)| {
                left == right || (!match_case && left.to_lowercase().eq(right.to_lowercase()))
            });
        if matches {
            let start_byte = line_chars[start].0;
            let end_index = start + query_chars.len();
            let end_byte = line_chars
                .get(end_index)
                .map(|(byte, _)| *byte)
                .unwrap_or(line.len());
            ranges.push((start_byte, end_byte));
            start = end_index;
        } else {
            start += 1;
        }
    }
    ranges
}

fn is_whole_word(line: &str, start: usize, end: usize) -> bool {
    let is_word_character = |character: char| character.is_alphanumeric() || character == '_';
    !line[..start]
        .chars()
        .next_back()
        .is_some_and(is_word_character)
        && !line[end..].chars().next().is_some_and(is_word_character)
}

#[tauri::command]
pub async fn editor_get_home_directory() -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to get home directory".to_string())?;
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
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directories: {}", e))?;
    }

    // A "new file" action must never truncate an existing file.
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&safe)
        .map(|_| ())
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                format!("File already exists: {}", safe.display())
            } else {
                format!("Failed to create file: {}", e)
            }
        })
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

    fs::rename(&src, &dst).map_err(|e| format!("Failed to rename: {}", e))
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

    fs::create_dir_all(&safe).map_err(|e| format!("Failed to create directory: {}", e))
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
    let content = fs::read_to_string(&safe).map_err(|e| format!("Failed to read file: {}", e))?;
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
    fs::write(&safe, &content).map_err(|e| format!("Failed to write file: {}", e))
}

/// Check if a file/directory should be ignored
fn should_ignore(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "__pycache__" | "target" | ".venv"
    )
}

#[cfg(test)]
mod editor_find_in_files_tests {
    use super::*;
    use tempfile::TempDir;

    fn search(
        root: &TempDir,
        query: &str,
        regex: bool,
        match_case: bool,
        whole_word: bool,
        file_pattern: Option<&str>,
    ) -> Result<Vec<EditorSearchMatch>, String> {
        editor_find_in_files(
            root.path().to_string_lossy().to_string(),
            query.to_string(),
            regex,
            match_case,
            whole_word,
            file_pattern.map(str::to_string),
            100,
        )
    }

    #[test]
    fn find_in_files_returns_sorted_literal_matches_with_one_based_positions() {
        let root = TempDir::new().unwrap();
        let last = root.path().join("z-last.txt");
        let first = root.path().join("a-first.txt");
        std::fs::write(&last, "before\nneedle tail\n").unwrap();
        std::fs::write(&first, "α needle first\n").unwrap();
        let last = std::fs::canonicalize(last).unwrap();
        let first = std::fs::canonicalize(first).unwrap();

        let matches = search(&root, "needle", false, true, false, None).unwrap();
        let actual: Vec<_> = matches
            .iter()
            .map(|found| {
                (
                    found.file_path.as_str(),
                    found.line,
                    found.column,
                    found.preview.as_str(),
                )
            })
            .collect();

        assert_eq!(
            actual,
            vec![
                (first.to_str().unwrap(), 1, 3, "α needle first"),
                (last.to_str().unwrap(), 2, 1, "needle tail"),
            ]
        );
    }

    #[test]
    fn find_in_files_bounds_unicode_preview_without_changing_match_position() {
        let root = TempDir::new().unwrap();
        let long_line = format!("{}needle{}", "é".repeat(200), "界".repeat(200));
        std::fs::write(
            root.path().join("unicode.txt"),
            format!("header\n{long_line}\n"),
        )
        .unwrap();

        let matches = search(&root, "needle", false, true, false, None).unwrap();

        assert_eq!(matches.len(), 1);
        let found = &matches[0];
        assert_eq!((found.line, found.column), (2, 201));
        assert!(found.preview.chars().count() <= 160);
        assert!(found.preview.starts_with('é'));
        assert!(found.preview.contains("needle"));
        assert!(found.preview.ends_with('界'));
    }

    #[test]
    fn find_in_files_applies_regex_case_and_literal_word_filters() {
        let root = TempDir::new().unwrap();
        std::fs::write(
            root.path().join("router.cfg"),
            "Interface Gi1/0/1\ninterface Gi1/0/2\ncat catalog\n",
        )
        .unwrap();
        std::fs::write(root.path().join("switch.txt"), "interface Gi1/0/3\ncat\n").unwrap();
        std::fs::write(root.path().join("README.md"), "INTERFACE Gi1/0/4\n").unwrap();

        let case_sensitive = search(
            &root,
            r"^interface Gi\d/\d/\d$",
            true,
            true,
            false,
            Some("*.cfg, README.md"),
        )
        .unwrap();
        assert_eq!(case_sensitive.len(), 1);
        assert_eq!(case_sensitive[0].preview, "interface Gi1/0/2");

        let case_insensitive = search(
            &root,
            r"^interface Gi\d/\d/\d$",
            true,
            false,
            false,
            Some("*.cfg, README.md"),
        )
        .unwrap();
        assert_eq!(case_insensitive.len(), 3);

        let literal_case_sensitive =
            search(&root, "Interface", false, true, false, Some("*.cfg")).unwrap();
        assert_eq!(literal_case_sensitive.len(), 1);

        let literal_case_insensitive =
            search(&root, "Interface", false, false, false, Some("*.cfg")).unwrap();
        assert_eq!(literal_case_insensitive.len(), 2);

        let words = search(&root, "cat", false, true, true, Some("*.cfg")).unwrap();
        assert_eq!(words.len(), 1);
        assert_eq!((words[0].line, words[0].column), (3, 1));

        assert!(search(&root, "[", true, true, false, None).is_err());
        assert!(search(&root, "cat", true, true, true, None).is_err());
        assert!(search(&root, "", false, true, false, None).is_err());
        assert!(editor_find_in_files(
            root.path().to_string_lossy().to_string(),
            "cat".to_string(),
            false,
            true,
            false,
            None,
            0,
        )
        .is_err());
    }

    #[test]
    fn find_in_files_rejects_workspace_escape_and_skips_ignored_entries() {
        let root = TempDir::new().unwrap();
        let ignored = root.path().join(".git");
        std::fs::create_dir(&ignored).unwrap();
        std::fs::write(ignored.join("secret.txt"), "hidden needle\n").unwrap();

        assert!(search(&root, "needle", false, true, false, None)
            .unwrap()
            .is_empty());

        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("secret.txt");
        std::fs::write(&outside_file, "escaped needle\n").unwrap();
        let link = root.path().join("escape.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside_file, &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&outside_file, &link).unwrap();

        let error = search(&root, "needle", false, true, false, None)
            .expect_err("a symlink outside the workspace must be rejected");
        assert!(error.contains("outside workspace root"), "{error}");
    }
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
    }
    .to_string()
}

#[cfg(test)]
mod editor_file_mutation_tests {
    use super::*;
    use tempfile::TempDir;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().unwrap()
    }

    #[test]
    fn create_file_creates_an_empty_file_without_overwriting_an_existing_one() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let file = dir.path().join("src").join("main.py");
        let path = file.to_string_lossy().to_string();

        rt().block_on(editor_create_file(path.clone(), Some(root.clone())))
            .expect("new file should be created");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "");

        std::fs::write(&file, "preserve me\n").unwrap();
        let error = rt()
            .block_on(editor_create_file(path, Some(root)))
            .expect_err("an existing file must not be overwritten");

        assert!(error.contains("already exists"), "{error}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "preserve me\n");
    }
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
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "resource \"y\" {}\n"
        );
    }

    #[test]
    fn rejects_paths_outside_workspace() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        // A traversal that escapes the workspace must be rejected.
        let escape = dir
            .path()
            .join("../../etc/hosts")
            .to_string_lossy()
            .to_string();
        let res = rt().block_on(iac_studio_read_file(escape, Some(root)));
        assert!(res.is_err(), "path outside workspace must be rejected");
    }

    #[test]
    fn write_creates_missing_parent_dirs_within_workspace() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let nested = dir
            .path()
            .join(".github")
            .join("workflows")
            .join("terraform.yml");
        let fp = nested.to_string_lossy().to_string();

        rt().block_on(iac_studio_write_file(
            fp.clone(),
            "name: terraform\n".to_string(),
            Some(root.clone()),
        ))
        .expect("write should create parent dirs and succeed");

        assert_eq!(
            std::fs::read_to_string(&nested).unwrap(),
            "name: terraform\n"
        );
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
