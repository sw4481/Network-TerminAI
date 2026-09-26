use anyhow::{anyhow, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct Block {
    pub id: String,
    pub tab_id: String,
    pub cmd: String,
    pub cwd: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub output_line_count: i32,
    pub is_bookmarked: i32,
    pub ai_analysis: Option<String>,
    pub ai_explanation: Option<String>,
    pub error_analysis: Option<String>,
    pub duration_ms: Option<i32>,
    #[serde(default)]
    pub collapsed: i32,
    #[serde(default, rename = "iacExecutionId")]
    pub iac_execution_id: Option<String>,
}

/// Snapshot used for blocks_by_tag responses + share payloads.
/// Slimmer than `Block` because consumers (tag-filter row, share popover)
/// don't need the full agent/AI columns and shares survive block deletion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockDto {
    pub id: String,
    pub tab_id: String,
    pub cmd: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

fn read_block_dto(conn: &Connection, block_id: &str) -> Result<BlockDto> {
    conn.query_row(
        "SELECT id, tab_id, cmd, output, exit_code, started_at, ended_at
         FROM command_blocks WHERE id = ?",
        params![block_id],
        |row| {
            Ok(BlockDto {
                id: row.get(0)?,
                tab_id: row.get(1)?,
                cmd: row.get(2)?,
                output: row.get(3)?,
                exit_code: row.get(4)?,
                started_at: row.get(5)?,
                ended_at: row.get(6)?,
            })
        },
    )
    .map_err(Into::into)
}

// ---------------------------------------------------------------------------
// Pure helpers (testable without a Tauri State).
// ---------------------------------------------------------------------------

pub fn add_tag(conn: &Connection, block_id: &str, tag: &str) -> Result<()> {
    if tag.is_empty() {
        return Err(anyhow!("tag must not be empty"));
    }
    conn.execute(
        "INSERT OR IGNORE INTO block_tags (block_id, tag) VALUES (?, ?)",
        params![block_id, tag],
    )?;
    Ok(())
}

pub fn remove_tag(conn: &Connection, block_id: &str, tag: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM block_tags WHERE block_id = ? AND tag = ?",
        params![block_id, tag],
    )?;
    Ok(())
}

pub fn list_tags(conn: &Connection, block_id: &str) -> Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT tag FROM block_tags WHERE block_id = ? ORDER BY tag ASC")?;
    let tags = stmt
        .query_map(params![block_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(tags)
}

pub fn blocks_by_tag_inner(conn: &Connection, tab_id: &str, tag: &str) -> Result<Vec<BlockDto>> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.tab_id, b.cmd, b.output, b.exit_code, b.started_at, b.ended_at
         FROM command_blocks b
         INNER JOIN block_tags t ON t.block_id = b.id
         WHERE b.tab_id = ? AND t.tag = ?
         ORDER BY b.started_at DESC",
    )?;
    let rows = stmt
        .query_map(params![tab_id, tag], |row| {
            Ok(BlockDto {
                id: row.get(0)?,
                tab_id: row.get(1)?,
                cmd: row.get(2)?,
                output: row.get(3)?,
                exit_code: row.get(4)?,
                started_at: row.get(5)?,
                ended_at: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn pin_block(conn: &Connection, block_id: &str, position: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO block_pins (block_id, position) VALUES (?, ?)
         ON CONFLICT(block_id) DO UPDATE SET position = excluded.position",
        params![block_id, position],
    )?;
    Ok(())
}

pub fn unpin_block(conn: &Connection, block_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM block_pins WHERE block_id = ?",
        params![block_id],
    )?;
    Ok(())
}

pub fn list_pinned_inner(conn: &Connection, tab_id: &str) -> Result<Vec<BlockDto>> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.tab_id, b.cmd, b.output, b.exit_code, b.started_at, b.ended_at
         FROM command_blocks b
         INNER JOIN block_pins p ON p.block_id = b.id
         WHERE b.tab_id = ?
         ORDER BY p.position ASC, p.pinned_at ASC",
    )?;
    let rows = stmt
        .query_map(params![tab_id], |row| {
            Ok(BlockDto {
                id: row.get(0)?,
                tab_id: row.get(1)?,
                cmd: row.get(2)?,
                output: row.get(3)?,
                exit_code: row.get(4)?,
                started_at: row.get(5)?,
                ended_at: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn set_collapsed_inner(conn: &Connection, block_id: &str, collapsed: bool) -> Result<()> {
    conn.execute(
        "UPDATE command_blocks SET collapsed = ? WHERE id = ?",
        params![if collapsed { 1 } else { 0 }, block_id],
    )?;
    Ok(())
}

pub fn block_share_create_inner(conn: &Connection, block_id: &str) -> Result<String> {
    let dto = read_block_dto(conn, block_id)?;
    let payload = serde_json::to_string(&dto)?;
    let share_id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO block_shares (share_id, block_id, payload_json) VALUES (?, ?, ?)",
        params![share_id, block_id, payload],
    )?;
    Ok(share_id)
}

/// Parse a `ccie-terminal://block/<share_id>` deep-link URL and return the
/// share id if the URL targets a shared block.
///
/// Pure function — no Tauri State — so it can be unit-tested directly. Used
/// from the `on_open_url` handler in `lib.rs` and from
/// `src-tauri/tests/deep_link_test.rs`.
///
/// Accepts URLs like:
/// - `ccie-terminal://block/abc-123`              → `Some("abc-123")`
/// - `ccie-terminal://block/abc-123/extra`        → `Some("abc-123")` (anything past the id is ignored)
///
/// Rejects (returns `None`) for:
/// - Wrong scheme (e.g. `https://...`, `myapp://...`)
/// - Wrong host/path (e.g. `ccie-terminal://other/x`, `ccie-terminal://block`)
/// - Empty share id (e.g. `ccie-terminal://block/`)
pub fn parse_share_url(url: &str) -> Option<String> {
    // Scheme check.
    let rest = url.strip_prefix("ccie-terminal://")?;

    // Strip optional query / fragment so a trailing `?foo=bar` or `#frag`
    // doesn't end up in the share id.
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);

    // Expect `block/<id>...` (host is "block" in URI parlance, but treat the
    // whole thing as a path since Tauri's plugin gives us the raw URL).
    let after_host = rest.strip_prefix("block/")?;

    // Take the first path segment as the share id.
    let id = after_host.split('/').next().unwrap_or("");
    if id.is_empty() {
        return None;
    }
    Some(id.to_string())
}

pub fn block_share_fetch_inner(conn: &Connection, share_id: &str) -> Result<BlockDto> {
    let payload: String = conn.query_row(
        "SELECT payload_json FROM block_shares WHERE share_id = ?",
        params![share_id],
        |row| row.get(0),
    )?;
    let dto: BlockDto = serde_json::from_str(&payload)?;
    Ok(dto)
}

/// Revoke a previously-created block share by deleting its row in
/// `block_shares`. Subsequent calls to `block_share_fetch_inner` for the
/// same `share_id` will return `Err` because no row matches.
///
/// Idempotent: revoking an already-revoked or never-existed `share_id`
/// returns `Ok(())` (the DELETE simply matches zero rows).
pub fn block_share_revoke_inner(conn: &Connection, share_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM block_shares WHERE share_id = ?",
        params![share_id],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn blocks_list(
    state: State<'_, AppState>,
    tab_id: String,
    limit: usize,
) -> Result<Vec<Block>, String> {
    let conn = state.db.lock();

    let mut stmt = conn
        .prepare(
            "SELECT id, tab_id, cmd, cwd, output, exit_code, started_at, ended_at,
                    output_line_count, is_bookmarked, ai_analysis, ai_explanation, error_analysis, duration_ms,
                    collapsed, iac_execution_id
             FROM command_blocks
             WHERE tab_id = ?
             ORDER BY started_at DESC
             LIMIT ?"
        )
        .map_err(|e| e.to_string())?;

    let blocks = stmt
        .query_map(rusqlite::params![tab_id, limit], |row| {
            // Handle output as either BLOB or TEXT
            let output_value: rusqlite::types::Value = row.get(4)?;
            let output = match output_value {
                rusqlite::types::Value::Blob(bytes) => String::from_utf8_lossy(&bytes).to_string(),
                rusqlite::types::Value::Text(text) => text,
                _ => String::new(),
            };

            Ok(Block {
                id: row.get(0)?,
                tab_id: row.get(1)?,
                cmd: row.get(2)?,
                cwd: row.get(3)?,
                output,
                exit_code: row.get(5)?,
                started_at: row.get(6)?,
                ended_at: row.get(7)?,
                output_line_count: row.get(8)?,
                is_bookmarked: row.get(9)?,
                ai_analysis: row.get(10)?,
                ai_explanation: row.get(11)?,
                error_analysis: row.get(12)?,
                duration_ms: row.get(13)?,
                collapsed: row.get(14)?,
                iac_execution_id: row.get(15)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(blocks)
}

#[tauri::command]
pub async fn blocks_upsert(state: State<'_, AppState>, block: Block) -> Result<(), String> {
    let conn = state.db.lock();

    conn.execute(
        "INSERT INTO command_blocks
         (id, tab_id, cmd, cwd, output, exit_code, started_at, ended_at,
          output_line_count, is_bookmarked, ai_analysis, ai_explanation, error_analysis, duration_ms,
          collapsed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(id) DO UPDATE SET
           output = excluded.output,
           exit_code = excluded.exit_code,
           ended_at = excluded.ended_at,
           output_line_count = excluded.output_line_count,
           is_bookmarked = excluded.is_bookmarked,
           ai_analysis = excluded.ai_analysis,
           ai_explanation = excluded.ai_explanation,
           error_analysis = excluded.error_analysis,
           duration_ms = excluded.duration_ms,
           collapsed = excluded.collapsed",
        rusqlite::params![
            block.id,
            block.tab_id,
            block.cmd,
            block.cwd,
            block.output,
            block.exit_code,
            block.started_at,
            block.ended_at,
            block.output_line_count,
            block.is_bookmarked,
            block.ai_analysis,
            block.ai_explanation,
            block.error_analysis,
            block.duration_ms,
            block.collapsed,
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn blocks_delete(state: State<'_, AppState>, block_id: String) -> Result<(), String> {
    let conn = state.db.lock();

    conn.execute(
        "DELETE FROM command_blocks WHERE id = ?",
        rusqlite::params![block_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn blocks_get_recent(
    state: State<'_, AppState>,
    tab_id: String,
    limit: usize,
) -> Result<Vec<Block>, String> {
    let conn = state.db.lock();

    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT id, tab_id, cmd, cwd, output, exit_code, started_at, ended_at,
                    output_line_count, is_bookmarked, ai_analysis, ai_explanation, error_analysis, duration_ms,
                    collapsed, iac_execution_id
             FROM command_blocks
             WHERE tab_id = ? AND cmd != ''
             ORDER BY started_at DESC
             LIMIT ?"
        )
        .map_err(|e| e.to_string())?;

    let blocks = stmt
        .query_map(rusqlite::params![tab_id, limit], |row| {
            // Handle output as either BLOB or TEXT
            let output_value: rusqlite::types::Value = row.get(4)?;
            let output = match output_value {
                rusqlite::types::Value::Blob(bytes) => String::from_utf8_lossy(&bytes).to_string(),
                rusqlite::types::Value::Text(text) => text,
                _ => String::new(),
            };

            Ok(Block {
                id: row.get(0)?,
                tab_id: row.get(1)?,
                cmd: row.get(2)?,
                cwd: row.get(3)?,
                output,
                exit_code: row.get(5)?,
                started_at: row.get(6)?,
                ended_at: row.get(7)?,
                output_line_count: row.get(8)?,
                is_bookmarked: row.get(9)?,
                ai_analysis: row.get(10)?,
                ai_explanation: row.get(11)?,
                error_analysis: row.get(12)?,
                duration_ms: row.get(13)?,
                collapsed: row.get(14)?,
                iac_execution_id: row.get(15)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(blocks)
}

// ---------------------------------------------------------------------------
// Tags / pins / shares — Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn block_tag_add(
    state: State<'_, AppState>,
    block_id: String,
    tag: String,
) -> std::result::Result<(), String> {
    let conn = state.db.lock();
    add_tag(&conn, &block_id, &tag).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn block_tag_remove(
    state: State<'_, AppState>,
    block_id: String,
    tag: String,
) -> std::result::Result<(), String> {
    let conn = state.db.lock();
    remove_tag(&conn, &block_id, &tag).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn block_tags_list(
    state: State<'_, AppState>,
    block_id: String,
) -> std::result::Result<Vec<String>, String> {
    let conn = state.db.lock();
    list_tags(&conn, &block_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn blocks_by_tag(
    state: State<'_, AppState>,
    tab_id: String,
    tag: String,
) -> std::result::Result<Vec<BlockDto>, String> {
    let conn = state.db.lock();
    blocks_by_tag_inner(&conn, &tab_id, &tag).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn block_pin(
    state: State<'_, AppState>,
    block_id: String,
    position: i64,
) -> std::result::Result<(), String> {
    let conn = state.db.lock();
    pin_block(&conn, &block_id, position).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn block_unpin(
    state: State<'_, AppState>,
    block_id: String,
) -> std::result::Result<(), String> {
    let conn = state.db.lock();
    unpin_block(&conn, &block_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn blocks_list_pinned(
    state: State<'_, AppState>,
    tab_id: String,
) -> std::result::Result<Vec<BlockDto>, String> {
    let conn = state.db.lock();
    list_pinned_inner(&conn, &tab_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn block_set_collapsed(
    state: State<'_, AppState>,
    block_id: String,
    collapsed: bool,
) -> std::result::Result<(), String> {
    let conn = state.db.lock();
    set_collapsed_inner(&conn, &block_id, collapsed).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn block_share_create(
    state: State<'_, AppState>,
    block_id: String,
) -> std::result::Result<String, String> {
    let conn = state.db.lock();
    block_share_create_inner(&conn, &block_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn block_share_fetch(
    state: State<'_, AppState>,
    share_id: String,
) -> std::result::Result<BlockDto, String> {
    let conn = state.db.lock();
    block_share_fetch_inner(&conn, &share_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn block_share_revoke(
    state: State<'_, AppState>,
    share_id: String,
) -> std::result::Result<(), String> {
    let conn = state.db.lock();
    block_share_revoke_inner(&conn, &share_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn blocks_get_bookmarked(state: State<'_, AppState>) -> Result<Vec<Block>, String> {
    let conn = state.db.lock();

    let mut stmt = conn
        .prepare(
            "SELECT id, tab_id, cmd, cwd, output, exit_code, started_at, ended_at,
                    output_line_count, is_bookmarked, ai_analysis, ai_explanation, error_analysis, duration_ms,
                    collapsed, iac_execution_id
             FROM command_blocks
             WHERE is_bookmarked = 1
             ORDER BY started_at DESC"
        )
        .map_err(|e| e.to_string())?;

    let blocks = stmt
        .query_map([], |row| {
            // Handle output as either BLOB or TEXT
            let output_value: rusqlite::types::Value = row.get(4)?;
            let output = match output_value {
                rusqlite::types::Value::Blob(bytes) => String::from_utf8_lossy(&bytes).to_string(),
                rusqlite::types::Value::Text(text) => text,
                _ => String::new(),
            };

            Ok(Block {
                id: row.get(0)?,
                tab_id: row.get(1)?,
                cmd: row.get(2)?,
                cwd: row.get(3)?,
                output,
                exit_code: row.get(5)?,
                started_at: row.get(6)?,
                ended_at: row.get(7)?,
                output_line_count: row.get(8)?,
                is_bookmarked: row.get(9)?,
                ai_analysis: row.get(10)?,
                ai_explanation: row.get(11)?,
                error_analysis: row.get(12)?,
                duration_ms: row.get(13)?,
                collapsed: row.get(14)?,
                iac_execution_id: row.get(15)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(blocks)
}
