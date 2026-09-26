//! MCP server session management
//!
//! Handles storage and retrieval of MCP server configurations.
//! Servers can use either stdio (local process) or SSE (remote HTTP) transport.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub transport: String,
    pub command_json: Option<Value>,
    pub url: Option<String>,
    pub env_json: Option<Value>,
    pub enabled: bool,
}

/// Add a new MCP server configuration
pub fn add_mcp_server(
    conn: &Connection,
    id: &str,
    name: &str,
    transport: &str,
    command_json: Option<Value>,
    url: Option<String>,
    env_json: Option<Value>,
) -> Result<()> {
    let command_json_str = command_json.map(|v| v.to_string());
    let env_json_str = env_json.map(|v| v.to_string());

    conn.execute(
        "INSERT INTO mcp_servers (id, name, transport, command_json, url, env_json) VALUES (?, ?, ?, ?, ?, ?)",
        params![id, name, transport, command_json_str, url, env_json_str],
    )
    .context("insert mcp_server")?;

    Ok(())
}

/// List all MCP servers
pub fn list_mcp_servers(conn: &Connection) -> Result<Vec<McpServer>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, transport, command_json, url, env_json, enabled
             FROM mcp_servers
             ORDER BY created_at",
        )
        .context("prepare list_mcp_servers")?;

    let rows = stmt
        .query_map([], |row| {
            let command_json_str: Option<String> = row.get(3)?;
            let env_json_str: Option<String> = row.get(5)?;

            Ok(McpServer {
                id: row.get(0)?,
                name: row.get(1)?,
                transport: row.get(2)?,
                command_json: command_json_str.and_then(|s| serde_json::from_str(&s).ok()),
                url: row.get(4)?,
                env_json: env_json_str.and_then(|s| serde_json::from_str(&s).ok()),
                enabled: row.get::<_, i32>(6)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(rows)
}

/// Remove an MCP server
pub fn remove_mcp_server(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM mcp_servers WHERE id = ?", params![id])
        .context("delete mcp_server")?;
    Ok(())
}

/// Enable or disable an MCP server
pub fn set_mcp_server_enabled(conn: &Connection, id: &str, enabled: bool) -> Result<()> {
    conn.execute(
        "UPDATE mcp_servers SET enabled = ? WHERE id = ?",
        params![enabled as i32, id],
    )
    .context("update mcp_server enabled")?;
    Ok(())
}

/// Get a specific MCP server by ID
pub fn get_mcp_server(conn: &Connection, id: &str) -> Result<Option<McpServer>> {
    let result = conn
        .query_row(
            "SELECT id, name, transport, command_json, url, env_json, enabled
             FROM mcp_servers
             WHERE id = ?",
            params![id],
            |row| {
                let command_json_str: Option<String> = row.get(3)?;
                let env_json_str: Option<String> = row.get(5)?;

                Ok(McpServer {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    transport: row.get(2)?,
                    command_json: command_json_str.and_then(|s| serde_json::from_str(&s).ok()),
                    url: row.get(4)?,
                    env_json: env_json_str.and_then(|s| serde_json::from_str(&s).ok()),
                    enabled: row.get::<_, i32>(6)? != 0,
                })
            },
        )
        .optional()?;

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_add_and_list_servers() {
        let conn = Connection::open_in_memory().unwrap();

        // Create table manually for test
        conn.execute(
            "CREATE TABLE mcp_servers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                transport TEXT NOT NULL,
                command_json TEXT,
                url TEXT,
                env_json TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            )",
            [],
        )
        .unwrap();

        add_mcp_server(
            &conn,
            "test",
            "Test Server",
            "stdio",
            Some(json!({"cmd": "test", "args": []})),
            None,
            None,
        )
        .unwrap();

        let servers = list_mcp_servers(&conn).unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].id, "test");
    }

    #[test]
    fn test_remove_server() {
        let conn = Connection::open_in_memory().unwrap();

        conn.execute(
            "CREATE TABLE mcp_servers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                transport TEXT NOT NULL,
                command_json TEXT,
                url TEXT,
                env_json TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            )",
            [],
        )
        .unwrap();

        add_mcp_server(&conn, "test", "Test", "stdio", None, None, None).unwrap();
        remove_mcp_server(&conn, "test").unwrap();

        let servers = list_mcp_servers(&conn).unwrap();
        assert_eq!(servers.len(), 0);
    }
}
