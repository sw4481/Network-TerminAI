//! Creates and persists a NETCONF tab. Does NOT open a session — that happens
//! via `netconf_connect` later. Only the DB rows are written here.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use uuid::Uuid;

use crate::session::Tab;

/// Create a new NETCONF tab and its companion `netconf_tab_state` row with
/// the default editor mode (`raw_xml`), empty content, and target datastore
/// `running`. No session is opened; `session_id` remains NULL.
pub fn create_netconf_tab(conn: &Connection, title: &str) -> Result<Tab> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd, tab_type) VALUES (?, ?, '', '', 'netconf')",
        params![id, title],
    )
    .context("insert netconf tab")?;
    conn.execute(
        "INSERT INTO netconf_tab_state (tab_id, editor_mode, editor_content, target_datastore)
         VALUES (?, 'raw_xml', '', 'running')",
        params![id],
    )
    .context("insert netconf_tab_state")?;
    let created_at: i64 = conn
        .query_row("SELECT created_at FROM tabs WHERE id = ?", params![id], |r| r.get(0))
        .context("read created_at")?;
    Ok(Tab {
        id,
        title: title.into(),
        shell_cmd: String::new(),
        cwd: String::new(),
        created_at,
        tab_type: "netconf".to_string(),
    })
}
