//! SQLite-backed store for tabs, command blocks, and scrollback.
//! Pure data layer — no PTY, no Tauri. Everything is synchronous rusqlite.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tab {
    pub id: String,
    pub title: String,
    pub shell_cmd: String,
    pub cwd: String,
    pub created_at: i64,
    /// Discriminator between PTY-backed terminal tabs and API Runner tabs.
    /// Defaults to `"terminal"` so existing serialized snapshots stay valid.
    #[serde(default = "default_tab_type")]
    pub tab_type: String,
}

fn default_tab_type() -> String {
    "terminal".to_string()
}

#[derive(Debug, Clone, Serialize)]
pub struct CommandBlockRow {
    pub id: String,
    pub tab_id: String,
    pub cmd: String,
    pub exit_code: Option<i32>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub output: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScrollbackStats {
    pub total_bytes: i64,
    pub chunks: i64,
    pub oldest_seq: i64,
    pub newest_seq: i64,
}

pub fn create_tab(conn: &Connection, title: &str, shell_cmd: &str, cwd: &str) -> Result<Tab> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd, tab_type) VALUES (?, ?, ?, ?, 'terminal')",
        params![id, title, shell_cmd, cwd],
    )
    .context("insert tab")?;
    let created_at: i64 = conn
        .query_row(
            "SELECT created_at FROM tabs WHERE id = ?",
            params![id],
            |r| r.get(0),
        )
        .context("read created_at")?;
    Ok(Tab {
        id,
        title: title.into(),
        shell_cmd: shell_cmd.into(),
        cwd: cwd.into(),
        created_at,
        tab_type: "terminal".to_string(),
    })
}

/// Create a terminal tab row using a CALLER-SUPPLIED id (used by session
/// restore / reopen-closed so scrollback and pane_layouts — both keyed by
/// tab id — line up with the saved data). Idempotent: if the row already
/// exists (e.g. it was never deleted after close), the existing row is kept.
pub fn create_tab_with_id(
    conn: &Connection,
    id: &str,
    title: &str,
    shell_cmd: &str,
    cwd: &str,
) -> Result<Tab> {
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd, tab_type) \
         VALUES (?, ?, ?, ?, 'terminal') \
         ON CONFLICT(id) DO UPDATE SET closed_at = NULL",
        params![id, title, shell_cmd, cwd],
    )
    .context("insert or reactivate tab with id")?;
    let (title, shell_cmd, cwd, created_at): (String, String, String, i64) = conn
        .query_row(
            "SELECT title, shell_cmd, cwd, created_at FROM tabs WHERE id = ?",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .context("read tab after insert")?;
    Ok(Tab {
        id: id.to_string(),
        title,
        shell_cmd,
        cwd,
        created_at,
        tab_type: "terminal".to_string(),
    })
}

/// Create an API Runner tab. Does NOT spawn a PTY. Inserts a paired
/// api_tab_state row so per-tab state (target/env/endpoint) can be persisted.
pub fn create_api_tab(
    conn: &Connection,
    title: &str,
    target_id: Option<&str>,
    environment: Option<&str>,
) -> Result<Tab> {
    let id = Uuid::new_v4().to_string();
    // shell_cmd / cwd are unused for API tabs but the columns are NOT NULL.
    // Store empty strings to keep the schema compatible with prior snapshots.
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd, tab_type) VALUES (?, ?, '', '', 'api')",
        params![id, title],
    )
    .context("insert api tab")?;
    conn.execute(
        "INSERT INTO api_tab_state (tab_id, target_id, environment) VALUES (?, ?, ?)",
        params![id, target_id, environment],
    )
    .context("insert api_tab_state")?;
    let created_at: i64 = conn
        .query_row(
            "SELECT created_at FROM tabs WHERE id = ?",
            params![id],
            |r| r.get(0),
        )
        .context("read created_at")?;
    Ok(Tab {
        id,
        title: title.into(),
        shell_cmd: String::new(),
        cwd: String::new(),
        created_at,
        tab_type: "api".to_string(),
    })
}

/// Create a new Subnet Calculator tab (no PTY, no shell_cmd).
/// Like API/NETCONF tabs, this is purely a UI container with tab_type='subnet'.
pub fn create_subnet_tab(conn: &Connection, title: &str) -> Result<Tab> {
    let id = Uuid::new_v4().to_string();
    // shell_cmd / cwd are unused for subnet tabs but the columns are NOT NULL.
    // Store empty strings to keep the schema compatible.
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd, tab_type) VALUES (?, ?, '', '', 'subnet')",
        params![id, title],
    )
    .context("insert subnet tab")?;
    let created_at: i64 = conn
        .query_row(
            "SELECT created_at FROM tabs WHERE id = ?",
            params![id],
            |r| r.get(0),
        )
        .context("read created_at")?;
    Ok(Tab {
        id,
        title: title.into(),
        shell_cmd: String::new(),
        cwd: String::new(),
        created_at,
        tab_type: "subnet".to_string(),
    })
}

/// Create a new Editor tab (no PTY, no shell_cmd)
pub fn create_editor_tab(
    conn: &Connection,
    title: &str,
    file_path: Option<&str>,
) -> Result<Tab> {
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    let cwd = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("/"))
        .to_string_lossy()
        .to_string();

    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd, created_at, tab_type)
         VALUES (?, ?, '', ?, ?, 'editor')",
        params![&id, title, &cwd, now],
    )
    .context("insert editor tab")?;

    // If opening an existing file, populate editor_tab_state
    if let Some(path) = file_path {
        let language = detect_language_from_path(path);
        conn.execute(
            "INSERT INTO editor_tab_state (tab_id, file_path, language, is_dirty, updated_at)
             VALUES (?, ?, ?, 0, strftime('%s','now'))",
            params![&id, path, &language],
        )
        .context("insert editor_tab_state")?;
    }

    Ok(Tab {
        id,
        title: title.to_string(),
        shell_cmd: String::new(),
        cwd,
        created_at: now,
        tab_type: "editor".to_string(),
    })
}

fn detect_language_from_path(path: &str) -> String {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    match ext {
        "py" => "python",
        "js" => "javascript",
        "ts" => "typescript",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "tf" => "hcl",
        "md" => "markdown",
        "sh" | "bash" | "zsh" => "shell",
        _ => "plaintext",
    }.to_string()
}

pub fn list_open_tabs(conn: &Connection) -> Result<Vec<Tab>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, shell_cmd, cwd, created_at, tab_type FROM tabs WHERE closed_at IS NULL ORDER BY created_at",
        )
        .context("prepare list_open_tabs")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Tab {
                id: r.get(0)?,
                title: r.get(1)?,
                shell_cmd: r.get(2)?,
                cwd: r.get(3)?,
                created_at: r.get(4)?,
                tab_type: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn close_tab(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE tabs SET closed_at = strftime('%s','now') WHERE id = ?",
        params![id],
    )
    .context("close tab")?;
    Ok(())
}

/// Append bytes to a tab's scrollback ring buffer without enforcing size limit.
/// For production use, prefer `append_scrollback_with_limit`.
pub fn append_scrollback(conn: &Connection, tab_id: &str, chunk: &[u8]) -> Result<()> {
    let next_seq: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(seq), -1) + 1 FROM scrollback WHERE tab_id = ?",
            params![tab_id],
            |r| r.get(0),
        )
        .context("next seq")?;
    conn.execute(
        "INSERT INTO scrollback (tab_id, seq, chunk) VALUES (?, ?, ?)",
        params![tab_id, next_seq, chunk],
    )
    .context("insert scrollback")?;
    Ok(())
}

/// Per-tab scrollback cap enforced on the live PTY write path. Terminal
/// scrollback is a ring buffer, not durable history, so a few MB per tab is
/// plenty for restore-on-reopen. Without this the `scrollback` table grew
/// unbounded (observed: 7.8M rows / ~2.5 GB, ~99% of sessions.db), which also
/// slowed every write (each append does a per-tab aggregate under the shared
/// DB lock).
pub const MAX_SCROLLBACK_BYTES_PER_TAB: i64 = 2 * 1024 * 1024;

/// One-time cleanup: trim every tab's scrollback down to `max_bytes` (FIFO,
/// oldest chunks first). Returns the number of tabs that had rows deleted.
///
/// Idempotent and cheap on an already-trimmed DB: tabs already within the cap
/// are skipped without any DELETE. The caller decides whether to `VACUUM`
/// afterwards to reclaim the freed pages (only worth it when this returns > 0).
pub fn prune_all_scrollback(conn: &Connection, max_bytes: i64) -> Result<usize> {
    // Tabs whose total scrollback currently exceeds the cap.
    let over_cap: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT tab_id FROM scrollback \
                 GROUP BY tab_id \
                 HAVING SUM(LENGTH(chunk)) > ?",
            )
            .context("prepare over-cap tabs query")?;
        let rows = stmt
            .query_map(params![max_bytes], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };

    for tab_id in &over_cap {
        let total: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(LENGTH(chunk)), 0) FROM scrollback WHERE tab_id = ?",
                params![tab_id],
                |r| r.get(0),
            )
            .context("query scrollback total for prune")?;
        if total > max_bytes {
            delete_oldest_scrollback(conn, tab_id, total - max_bytes)?;
        }
    }

    Ok(over_cap.len())
}

/// Append bytes to a tab's scrollback ring buffer with size limit enforcement.
/// If total scrollback exceeds `max_bytes`, oldest chunks are deleted (FIFO).
pub fn append_scrollback_with_limit(
    conn: &Connection,
    tab_id: &str,
    chunk: &[u8],
    max_bytes: i64,
) -> Result<()> {
    // Get current size
    let current_size: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(LENGTH(chunk)), 0) FROM scrollback WHERE tab_id = ?",
            params![tab_id],
            |r| r.get(0),
        )
        .context("query current scrollback size")?;

    // If adding this chunk would exceed the limit, delete oldest chunks
    let new_total = current_size + chunk.len() as i64;
    if new_total > max_bytes {
        delete_oldest_scrollback(conn, tab_id, new_total - max_bytes)?;
    }

    // Insert the new chunk
    append_scrollback(conn, tab_id, chunk)
}

/// Delete oldest scrollback chunks for a tab to free up at least `bytes_to_free`.
/// Deletes by oldest `seq` first (FIFO).
fn delete_oldest_scrollback(conn: &Connection, tab_id: &str, bytes_to_free: i64) -> Result<()> {
    // Calculate how much we need to delete
    let mut freed: i64 = 0;
    let mut delete_up_to_seq: Option<i64> = None;

    // Get chunks ordered by seq (oldest first) with their sizes
    let mut stmt = conn
        .prepare("SELECT seq, LENGTH(chunk) FROM scrollback WHERE tab_id = ? ORDER BY seq")
        .context("prepare oldest chunks query")?;

    let mut rows = stmt.query(params![tab_id])?;

    while let Some(row) = rows.next()? {
        let seq: i64 = row.get(0)?;
        let size: i64 = row.get(1)?;

        freed += size;
        delete_up_to_seq = Some(seq);

        if freed >= bytes_to_free {
            break;
        }
    }

    // Delete all chunks up to and including delete_up_to_seq
    if let Some(max_seq) = delete_up_to_seq {
        conn.execute(
            "DELETE FROM scrollback WHERE tab_id = ? AND seq <= ?",
            params![tab_id, max_seq],
        )
        .context("delete oldest scrollback chunks")?;
    }

    Ok(())
}

pub fn read_scrollback(conn: &Connection, tab_id: &str) -> Result<Vec<u8>> {
    let mut stmt = conn.prepare("SELECT chunk FROM scrollback WHERE tab_id = ? ORDER BY seq")?;
    let mut out = Vec::new();
    let mut rows = stmt.query(params![tab_id])?;
    while let Some(r) = rows.next()? {
        let chunk: Vec<u8> = r.get(0)?;
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// Get statistics about scrollback for a tab.
pub fn scrollback_stats(conn: &Connection, tab_id: &str) -> Result<ScrollbackStats> {
    let mut stmt = conn.prepare(
        "SELECT
            COALESCE(SUM(LENGTH(chunk)), 0) as total_bytes,
            COUNT(*) as chunks,
            COALESCE(MIN(seq), 0) as oldest_seq,
            COALESCE(MAX(seq), 0) as newest_seq
         FROM scrollback
         WHERE tab_id = ?",
    )?;

    let stats = stmt.query_row(params![tab_id], |row| {
        Ok(ScrollbackStats {
            total_bytes: row.get(0)?,
            chunks: row.get(1)?,
            oldest_seq: row.get(2)?,
            newest_seq: row.get(3)?,
        })
    })?;

    Ok(stats)
}

pub fn start_command_block(conn: &Connection, tab_id: &str, cmd: &str) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at) VALUES (?, ?, ?, X'', strftime('%s','now'))",
        params![id, tab_id, cmd],
    )
    .context("insert command_block")?;
    Ok(id)
}

pub fn append_block_output(conn: &Connection, block_id: &str, chunk: &[u8]) -> Result<()> {
    // Read-modify-write is fine for Phase 1 (blocks are typically small).
    let mut current: Vec<u8> = conn
        .query_row(
            "SELECT output FROM command_blocks WHERE id = ?",
            params![block_id],
            |r| r.get(0),
        )
        .context("read existing block output")?;
    current.extend_from_slice(chunk);
    conn.execute(
        "UPDATE command_blocks SET output = ? WHERE id = ?",
        params![current, block_id],
    )
    .context("update block output")?;
    Ok(())
}

pub fn end_command_block(conn: &Connection, block_id: &str, exit_code: Option<i32>) -> Result<()> {
    conn.execute(
        "UPDATE command_blocks SET exit_code = ?, ended_at = strftime('%s','now') WHERE id = ?",
        params![exit_code, block_id],
    )
    .context("end command_block")?;
    Ok(())
}

pub fn list_blocks(conn: &Connection, tab_id: &str) -> Result<Vec<CommandBlockRow>> {
    // Only real shell blocks belong in the scrollback. Synthetic rows created
    // to satisfy parsed_outputs' FK (block_source != 'shell') are excluded.
    let mut stmt = conn.prepare(
        "SELECT id, tab_id, cmd, exit_code, started_at, ended_at, output FROM command_blocks WHERE tab_id = ? AND block_source = 'shell' ORDER BY started_at",
    )?;
    let rows = stmt
        .query_map(params![tab_id], |r| {
            Ok(CommandBlockRow {
                id: r.get(0)?,
                tab_id: r.get(1)?,
                cmd: r.get(2)?,
                exit_code: r.get(3)?,
                started_at: r.get(4)?,
                ended_at: r.get(5)?,
                output: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get_block_output(conn: &Connection, block_id: &str) -> Result<Vec<u8>> {
    let output: Vec<u8> = conn
        .query_row(
            "SELECT output FROM command_blocks WHERE id = ?",
            params![block_id],
            |r| r.get(0),
        )
        .context("read block output")?;
    Ok(output)
}

// Saved Sessions (Phase 6)

#[derive(Debug, Clone, Serialize)]
pub struct SavedSession {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub tab_count: usize,
    pub created_at: i64,
}

// Legacy snapshot structure (deprecated - use SessionSnapshot below)
#[derive(Debug, Clone, Serialize)]
pub struct SessionSnapshotLegacy {
    pub tabs: Vec<Tab>,
    pub scrollback: std::collections::HashMap<String, Vec<u8>>,
    pub ai_history: std::collections::HashMap<String, String>,
}

pub fn save_session(
    conn: &Connection,
    name: &str,
    description: Option<&str>,
    tabs: &[Tab],
    scrollback: &std::collections::HashMap<String, Vec<u8>>,
    ai_history: &std::collections::HashMap<String, String>,
) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    let tab_snapshot_json = serde_json::to_string(tabs).context("serialize tabs")?;

    conn.execute(
        "INSERT INTO saved_sessions (id, name, description, tab_snapshot_json) VALUES (?, ?, ?, ?)",
        params![id, name, description, tab_snapshot_json],
    )
    .context("insert saved_session")?;

    // Save scrollback for each tab
    for (tab_id, scrollback_data) in scrollback {
        conn.execute(
            "INSERT INTO session_scrollback (session_id, tab_id, scrollback) VALUES (?, ?, ?)",
            params![id, tab_id, scrollback_data],
        )
        .context("insert session_scrollback")?;
    }

    // Save AI history for each tab
    for (tab_id, messages_json) in ai_history {
        conn.execute(
            "INSERT INTO session_ai_history (session_id, tab_id, messages_json) VALUES (?, ?, ?)",
            params![id, tab_id, messages_json],
        )
        .context("insert session_ai_history")?;
    }

    Ok(id)
}

pub fn list_saved_sessions(conn: &Connection) -> Result<Vec<SavedSession>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, tab_snapshot_json, created_at FROM saved_sessions ORDER BY created_at DESC"
    )?;

    let rows = stmt
        .query_map([], |r| {
            let tab_snapshot_json: String = r.get(3)?;
            let tabs: Vec<Tab> = serde_json::from_str(&tab_snapshot_json).unwrap_or_default();

            Ok(SavedSession {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                tab_count: tabs.len(),
                created_at: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn load_session(conn: &Connection, session_id: &str) -> Result<SessionSnapshotLegacy> {
    let (tab_snapshot_json,): (String,) = conn
        .query_row(
            "SELECT tab_snapshot_json FROM saved_sessions WHERE id = ?",
            params![session_id],
            |r| Ok((r.get(0)?,)),
        )
        .context("read session")?;

    let tabs: Vec<Tab> = serde_json::from_str(&tab_snapshot_json).context("deserialize tabs")?;

    // Load scrollback
    let mut scrollback = std::collections::HashMap::new();
    let mut stmt =
        conn.prepare("SELECT tab_id, scrollback FROM session_scrollback WHERE session_id = ?")?;
    let mut rows = stmt.query(params![session_id])?;
    while let Some(r) = rows.next()? {
        let tab_id: String = r.get(0)?;
        let scrollback_data: Vec<u8> = r.get(1)?;
        scrollback.insert(tab_id, scrollback_data);
    }

    // Load AI history
    let mut ai_history = std::collections::HashMap::new();
    let mut stmt =
        conn.prepare("SELECT tab_id, messages_json FROM session_ai_history WHERE session_id = ?")?;
    let mut rows = stmt.query(params![session_id])?;
    while let Some(r) = rows.next()? {
        let tab_id: String = r.get(0)?;
        let messages_json: String = r.get(1)?;
        ai_history.insert(tab_id, messages_json);
    }

    Ok(SessionSnapshotLegacy {
        tabs,
        scrollback,
        ai_history,
    })
}

pub fn delete_saved_session(conn: &Connection, session_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM saved_sessions WHERE id = ?",
        params![session_id],
    )
    .context("delete saved_session")?;
    Ok(())
}

pub fn export_session_json(conn: &Connection, session_id: &str) -> Result<String> {
    let snapshot = load_session(conn, session_id)?;

    let session_info: (String, Option<String>, i64) = conn
        .query_row(
            "SELECT name, description, created_at FROM saved_sessions WHERE id = ?",
            params![session_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .context("read session info")?;

    let export_data = serde_json::json!({
        "id": session_id,
        "name": session_info.0,
        "description": session_info.1,
        "created_at": session_info.2,
        "tabs": snapshot.tabs,
        "scrollback": snapshot.scrollback,
        "ai_history": snapshot.ai_history,
    });

    serde_json::to_string_pretty(&export_data).context("serialize export data")
}

pub fn import_session_json(conn: &Connection, json_data: &str) -> Result<String> {
    let data: serde_json::Value = serde_json::from_str(json_data).context("parse import JSON")?;

    let name = data
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing name in import data"))?;

    let description = data.get("description").and_then(|v| v.as_str());

    let tabs: Vec<Tab> = serde_json::from_value(
        data.get("tabs")
            .ok_or_else(|| anyhow::anyhow!("missing tabs in import data"))?
            .clone(),
    )?;

    let scrollback: std::collections::HashMap<String, Vec<u8>> = serde_json::from_value(
        data.get("scrollback")
            .cloned()
            .unwrap_or(serde_json::json!({})),
    )?;

    let ai_history: std::collections::HashMap<String, String> = serde_json::from_value(
        data.get("ai_history")
            .cloned()
            .unwrap_or(serde_json::json!({})),
    )?;

    save_session(conn, name, description, &tabs, &scrollback, &ai_history)
}

// AI Messages

#[derive(Debug, Clone, Serialize)]
pub struct AiMessage {
    pub id: String,
    pub tab_id: String,
    pub role: String,
    pub content: String,
    pub timestamp: i64,
    /// Agent the message belongs to. None = general (no persona).
    #[serde(rename = "agentId")]
    pub agent_id: Option<String>,
}

/// Save a message tagged with the active agent (or None for general).
pub fn save_ai_message_with_agent(
    conn: &Connection,
    tab_id: &str,
    role: &str,
    content: &str,
    timestamp: i64,
    agent_id: Option<&str>,
) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO ai_messages (id, tab_id, role, content, timestamp, agent_id) VALUES (?, ?, ?, ?, ?, ?)",
        params![id, tab_id, role, content, timestamp, agent_id],
    )
    .context("insert ai_message")?;
    Ok(id)
}

/// Backward-compatible wrapper: saves with agent_id = NULL (general chat).
pub fn save_ai_message(
    conn: &Connection,
    tab_id: &str,
    role: &str,
    content: &str,
    timestamp: i64,
) -> Result<String> {
    save_ai_message_with_agent(conn, tab_id, role, content, timestamp, None)
}

pub fn get_ai_messages_by_tab(conn: &Connection, tab_id: &str) -> Result<Vec<AiMessage>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, tab_id, role, content, timestamp, agent_id FROM ai_messages WHERE tab_id = ? ORDER BY timestamp",
        )
        .context("prepare get_ai_messages_by_tab")?;
    let rows = stmt
        .query_map(params![tab_id], |r| {
            Ok(AiMessage {
                id: r.get(0)?,
                tab_id: r.get(1)?,
                role: r.get(2)?,
                content: r.get(3)?,
                timestamp: r.get(4)?,
                agent_id: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Get messages for a specific (tab, agent) pair. `agent_id = None` returns
/// only the general-chat rows; `Some("foo")` returns only rows for agent "foo".
pub fn get_ai_messages_by_tab_agent(
    conn: &Connection,
    tab_id: &str,
    agent_id: Option<&str>,
) -> Result<Vec<AiMessage>> {
    let (sql, rows) = match agent_id {
        Some(aid) => {
            let mut stmt = conn
                .prepare(
                    "SELECT id, tab_id, role, content, timestamp, agent_id \
                     FROM ai_messages WHERE tab_id = ? AND agent_id = ? ORDER BY timestamp",
                )
                .context("prepare get_ai_messages_by_tab_agent (agent)")?;
            let rows = stmt
                .query_map(params![tab_id, aid], |r| {
                    Ok(AiMessage {
                        id: r.get(0)?,
                        tab_id: r.get(1)?,
                        role: r.get(2)?,
                        content: r.get(3)?,
                        timestamp: r.get(4)?,
                        agent_id: r.get(5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            ("agent", rows)
        }
        None => {
            let mut stmt = conn
                .prepare(
                    "SELECT id, tab_id, role, content, timestamp, agent_id \
                     FROM ai_messages WHERE tab_id = ? AND agent_id IS NULL ORDER BY timestamp",
                )
                .context("prepare get_ai_messages_by_tab_agent (general)")?;
            let rows = stmt
                .query_map(params![tab_id], |r| {
                    Ok(AiMessage {
                        id: r.get(0)?,
                        tab_id: r.get(1)?,
                        role: r.get(2)?,
                        content: r.get(3)?,
                        timestamp: r.get(4)?,
                        agent_id: r.get(5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            ("general", rows)
        }
    };
    let _ = sql; // suppress unused
    Ok(rows)
}

/// Summary of one conversation (distinct tab_id × agent_id pair).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub tab_id: String,
    /// None = general chat
    pub agent_id: Option<String>,
    pub message_count: i64,
    /// Timestamp of the most recent message in this conversation.
    pub last_timestamp: i64,
    /// First 200 chars of the most recent user message (snippet).
    pub preview: String,
    /// Whether the tab still exists (helps UI mark orphaned conversations).
    pub tab_exists: bool,
    /// Tab title, if it still exists.
    pub tab_title: Option<String>,
}

/// List every conversation (distinct tab_id × agent_id) ordered by most recent.
pub fn list_conversations(conn: &Connection) -> Result<Vec<ConversationSummary>> {
    // Group by (tab_id, COALESCE(agent_id, '')), compute aggregates, join tab title.
    let mut stmt = conn
        .prepare(
            "SELECT am.tab_id,
                    am.agent_id,
                    COUNT(*) AS msg_count,
                    MAX(am.timestamp) AS last_ts,
                    t.title
               FROM ai_messages am
               LEFT JOIN tabs t ON t.id = am.tab_id
              GROUP BY am.tab_id, am.agent_id
              ORDER BY last_ts DESC",
        )
        .context("prepare list_conversations")?;
    let rows: Vec<(String, Option<String>, i64, i64, Option<String>)> = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // For each conversation, grab the most recent user message as a preview.
    let mut out = Vec::with_capacity(rows.len());
    for (tab_id, agent_id, msg_count, last_ts, tab_title) in rows {
        let preview: String = {
            let mut ps = if agent_id.is_some() {
                conn.prepare(
                    "SELECT content FROM ai_messages
                       WHERE tab_id = ? AND agent_id = ? AND role = 'user'
                       ORDER BY timestamp DESC LIMIT 1",
                )?
            } else {
                conn.prepare(
                    "SELECT content FROM ai_messages
                       WHERE tab_id = ? AND agent_id IS NULL AND role = 'user'
                       ORDER BY timestamp DESC LIMIT 1",
                )?
            };
            let row: rusqlite::Result<String> = match agent_id.as_deref() {
                Some(aid) => ps.query_row(params![&tab_id, aid], |r| r.get(0)),
                None => ps.query_row(params![&tab_id], |r| r.get(0)),
            };
            match row {
                Ok(s) => {
                    let trimmed = s.trim();
                    if trimmed.chars().count() > 200 {
                        let mut end = 0usize;
                        for (i, _) in trimmed.char_indices().take(200) {
                            end = i;
                        }
                        format!("{}…", &trimmed[..end])
                    } else {
                        trimmed.to_string()
                    }
                }
                Err(_) => String::new(),
            }
        };
        out.push(ConversationSummary {
            tab_exists: tab_title.is_some(),
            tab_id,
            agent_id,
            message_count: msg_count,
            last_timestamp: last_ts,
            preview,
            tab_title,
        });
    }
    Ok(out)
}

/// Delete all messages for a (tab, agent) pair. Used by the "Clear chat" button.
/// Returns the number of rows deleted.
pub fn clear_ai_messages(
    conn: &Connection,
    tab_id: &str,
    agent_id: Option<&str>,
) -> Result<usize> {
    let n = match agent_id {
        Some(aid) => conn.execute(
            "DELETE FROM ai_messages WHERE tab_id = ? AND agent_id = ?",
            params![tab_id, aid],
        )?,
        None => conn.execute(
            "DELETE FROM ai_messages WHERE tab_id = ? AND agent_id IS NULL",
            params![tab_id],
        )?,
    };
    Ok(n)
}

// Session Snapshots

#[derive(Debug, Clone, Serialize)]
pub struct TabSnapshot {
    pub id: String,
    pub title: String,
    pub shell_cmd: String,
    pub cwd: String,
    pub created_at: i64,
    pub scrollback: Vec<u8>,
    pub ai_messages: Vec<AiMessage>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionSnapshot {
    pub id: String,
    pub name: String,
    pub active_tab_id: Option<String>,
    pub tabs: Vec<TabSnapshot>,
    pub created_at: i64,
}

pub fn save_session_snapshot(
    conn: &Connection,
    name: &str,
    active_tab_id: Option<&str>,
    tab_ids: Option<&[String]>,
) -> Result<String> {
    let id = Uuid::new_v4().to_string();

    // Delete existing snapshot with this name
    conn.execute(
        "DELETE FROM session_snapshots WHERE name = ?",
        params![name],
    )
    .context("delete old snapshot")?;

    // Create new snapshot
    conn.execute(
        "INSERT INTO session_snapshots (id, name, active_tab_id) VALUES (?, ?, ?)",
        params![id, name, active_tab_id],
    )
    .context("insert session_snapshot")?;

    // Determine which tabs to link, in order. The frontend passes the live tab
    // bar's ids (`Some`), which is authoritative: `closed_at` leaks (tabs alive
    // at quit/crash never get closed), so `list_open_tabs` accumulates thousands
    // of stale rows over time. We snapshot exactly the live tabs, skipping any id
    // with no backing row. `None` falls back to the open-tab list for callers
    // (e.g. tests) that have a clean table.
    let ordered_ids: Vec<String> = match tab_ids {
        Some(ids) => {
            let mut kept = Vec::with_capacity(ids.len());
            for tid in ids {
                let count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM tabs WHERE id = ?",
                        params![tid],
                        |r| r.get(0),
                    )
                    .context("check tab exists for snapshot")?;
                if count > 0 {
                    kept.push(tid.clone());
                }
            }
            kept
        }
        None => list_open_tabs(conn)?.into_iter().map(|t| t.id).collect(),
    };

    for (order, tid) in ordered_ids.iter().enumerate() {
        conn.execute(
            "INSERT INTO session_snapshot_tabs (snapshot_id, tab_id, tab_order) VALUES (?, ?, ?)",
            params![id, tid, order as i64],
        )
        .context("insert snapshot_tab")?;
    }

    Ok(id)
}

pub fn load_session_snapshot(conn: &Connection, name: &str) -> Result<Option<SessionSnapshot>> {
    // Get snapshot metadata
    let snapshot_result: std::result::Result<(String, String, Option<String>, i64), _> = conn
        .query_row(
            "SELECT id, name, active_tab_id, created_at FROM session_snapshots WHERE name = ?",
            params![name],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        );

    let (snapshot_id, snapshot_name, active_tab_id, created_at) = match snapshot_result {
        Ok(data) => data,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(e) => return Err(e.into()),
    };

    // Get tabs in order
    let mut stmt = conn.prepare(
        "SELECT t.id, t.title, t.shell_cmd, t.cwd, t.created_at, t.tab_type
         FROM tabs t
         JOIN session_snapshot_tabs st ON t.id = st.tab_id
         WHERE st.snapshot_id = ?
         ORDER BY st.tab_order",
    )?;

    let tabs: Vec<TabSnapshot> = stmt
        .query_map(params![snapshot_id], |r| {
            let tab_id: String = r.get(0)?;
            let tab_type: String = r.get(5)?;
            Ok((tab_id, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, tab_type))
        })?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|(tab_id, title, shell_cmd, cwd, created_at, tab_type)| {
            // API tabs have no scrollback/pty output to restore.
            let scrollback = if tab_type == "api" {
                Vec::new()
            } else {
                read_scrollback(conn, &tab_id).unwrap_or_default()
            };
            let ai_messages = get_ai_messages_by_tab(conn, &tab_id).unwrap_or_default();
            TabSnapshot {
                id: tab_id,
                title,
                shell_cmd,
                cwd,
                created_at,
                scrollback,
                ai_messages,
            }
        })
        .collect();

    Ok(Some(SessionSnapshot {
        id: snapshot_id,
        name: snapshot_name,
        active_tab_id,
        tabs,
        created_at,
    }))
}

#[cfg(test)]
mod scrollback_tests {
    use super::*;

    /// In-memory DB with the full schema applied (mirrors
    /// `Database::new_in_memory`; scrollback has an FK to `tabs`).
    fn test_conn() -> Connection {
        crate::rag::vec::register_vec_auto_extension();
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        crate::rag::vec::enable_vec_extension(&conn).unwrap();
        crate::db::apply_migrations(&mut conn).unwrap();
        conn
    }

    #[test]
    fn create_tab_with_id_reuses_given_id_and_is_idempotent() {
        let conn = test_conn();
        let t1 = create_tab_with_id(&conn, "fixed-id-123", "zsh", "/bin/zsh", "/tmp").unwrap();
        assert_eq!(t1.id, "fixed-id-123");
        assert_eq!(t1.cwd, "/tmp");
        // Calling again with the same id must not error or duplicate the row.
        let t2 = create_tab_with_id(&conn, "fixed-id-123", "zsh", "/bin/zsh", "/other").unwrap();
        assert_eq!(t2.id, "fixed-id-123");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM tabs WHERE id = ?", params!["fixed-id-123"], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn save_then_restore_roundtrips_terminal_tab_with_scrollback() {
        let conn = test_conn();
        let tab = create_tab_with_id(&conn, "rt-1", "zsh", "/bin/zsh", "/work").unwrap();
        append_scrollback_with_limit(&conn, &tab.id, b"hello world", MAX_SCROLLBACK_BYTES_PER_TAB)
            .unwrap();
        save_session_snapshot(&conn, "__last__", Some(&tab.id), None).unwrap();

        let snap = load_session_snapshot(&conn, "__last__").unwrap().expect("snapshot");
        assert_eq!(snap.active_tab_id.as_deref(), Some("rt-1"));
        let restored = snap.tabs.iter().find(|t| t.id == "rt-1").expect("tab present");
        assert_eq!(restored.cwd, "/work");
        assert_eq!(restored.scrollback, b"hello world");
    }

    #[test]
    fn recreate_after_close_reactivates_tab_for_persistence() {
        let conn = test_conn();
        let tab = create_tab_with_id(&conn, "reopen-1", "zsh", "/bin/zsh", "/work").unwrap();
        close_tab(&conn, &tab.id).unwrap();
        // Closed tabs are excluded from the open list (and thus from snapshots).
        assert!(list_open_tabs(&conn).unwrap().iter().all(|t| t.id != "reopen-1"));

        // Reopening via create_tab_with_id must clear closed_at so it persists again.
        create_tab_with_id(&conn, "reopen-1", "zsh", "/bin/zsh", "/work").unwrap();
        assert!(list_open_tabs(&conn).unwrap().iter().any(|t| t.id == "reopen-1"));

        save_session_snapshot(&conn, "__last__", Some("reopen-1"), None).unwrap();
        let snap = load_session_snapshot(&conn, "__last__").unwrap().expect("snapshot");
        assert!(snap.tabs.iter().any(|t| t.id == "reopen-1"), "reopened tab must be in snapshot");
    }

    #[test]
    fn snapshot_with_explicit_tab_ids_ignores_leaked_open_rows() {
        let conn = test_conn();
        // Two live tabs plus a leaked "open" row that is NOT in the live tab bar
        // (the exact real-world state: closed_at never set on quit/crash).
        create_tab_with_id(&conn, "live-1", "zsh", "/bin/zsh", "/a").unwrap();
        create_tab_with_id(&conn, "live-2", "zsh", "/bin/zsh", "/b").unwrap();
        create_tab_with_id(&conn, "leaked-old", "zsh", "/bin/zsh", "/c").unwrap();
        // All three are "open" by closed_at, so list_open_tabs would grab all 3.
        assert_eq!(list_open_tabs(&conn).unwrap().len(), 3);

        // The frontend passes only the live tab ids, in tab-bar order.
        let live = vec!["live-2".to_string(), "live-1".to_string()];
        save_session_snapshot(&conn, "__last__", Some("live-2"), Some(&live)).unwrap();

        let snap = load_session_snapshot(&conn, "__last__").unwrap().expect("snapshot");
        assert_eq!(snap.tabs.len(), 2, "leaked row must not be snapshotted");
        assert!(snap.tabs.iter().all(|t| t.id != "leaked-old"));
        // Order is preserved from the passed ids.
        assert_eq!(snap.tabs[0].id, "live-2");
        assert_eq!(snap.tabs[1].id, "live-1");
    }

    #[test]
    fn snapshot_with_explicit_tab_ids_skips_ids_without_a_row() {
        let conn = test_conn();
        create_tab_with_id(&conn, "live-1", "zsh", "/bin/zsh", "/a").unwrap();
        // "ghost" has no backing tabs row — must be silently skipped, not error.
        let ids = vec!["live-1".to_string(), "ghost".to_string()];
        save_session_snapshot(&conn, "__last__", Some("live-1"), Some(&ids)).unwrap();

        let snap = load_session_snapshot(&conn, "__last__").unwrap().expect("snapshot");
        assert_eq!(snap.tabs.len(), 1);
        assert_eq!(snap.tabs[0].id, "live-1");
    }

    #[test]
    fn append_with_limit_evicts_oldest_and_keeps_recent() {
        let conn = test_conn();
        let tab = create_tab(&conn, "t", "sh", "/").unwrap();

        // Cap of 100 bytes; write 5 x 40-byte chunks (200 bytes total).
        for i in 0..5u8 {
            append_scrollback_with_limit(&conn, &tab.id, &[i; 40], 100).unwrap();
        }

        let stats = scrollback_stats(&conn, &tab.id).unwrap();
        assert!(
            stats.total_bytes <= 100,
            "total {} must stay within the 100-byte cap",
            stats.total_bytes
        );
        // FIFO: the most recent chunk (all 4s) must survive; the oldest (0s) gone.
        let data = read_scrollback(&conn, &tab.id).unwrap();
        assert!(data.ends_with(&[4u8; 40]), "newest chunk must be retained");
        assert!(!data.contains(&0u8), "oldest chunk must be evicted");
    }

    #[test]
    fn prune_all_trims_over_cap_tabs_and_skips_others() {
        let conn = test_conn();
        let big = create_tab(&conn, "big", "sh", "/").unwrap();
        let small = create_tab(&conn, "small", "sh", "/").unwrap();

        // `big` gets 300 bytes via the *unbounded* append (simulating legacy data).
        for i in 0..6u8 {
            append_scrollback(&conn, &big.id, &[i; 50]).unwrap();
        }
        // `small` stays under cap.
        append_scrollback(&conn, &small.id, &[9u8; 30]).unwrap();

        let pruned = prune_all_scrollback(&conn, 100).unwrap();
        assert_eq!(pruned, 1, "only the over-cap tab should be counted");

        assert!(scrollback_stats(&conn, &big.id).unwrap().total_bytes <= 100);
        assert_eq!(scrollback_stats(&conn, &small.id).unwrap().total_bytes, 30);

        // Idempotent: a second pass finds nothing over cap.
        assert_eq!(prune_all_scrollback(&conn, 100).unwrap(), 0);
    }

    #[test]
    fn prune_all_is_noop_on_empty_db() {
        let conn = test_conn();
        assert_eq!(prune_all_scrollback(&conn, 100).unwrap(), 0);
    }
}
