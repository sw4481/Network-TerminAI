//! NETCONF history tracking - records all sent RPCs with their responses.
//!
//! Mirrors `api_runner::history` structure. Each entry captures:
//! - Request XML and metadata (operation, datastore target)
//! - Response XML (truncated if > 1MB)
//! - Timing and error information
//! - Association with tab, device, or saved RPC

use crate::netconf_runner::error::{NetconfError, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// History list item (summary without full request/response bodies).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryItem {
    pub id: String,
    pub tab_id: Option<String>,
    pub device_id: Option<i64>,
    pub host: Option<String>,
    pub operation: String,
    pub status: String,
    pub duration_ms: Option<i64>,
    pub sent_at: String,
}

/// Full history detail including request and response XML.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryDetail {
    pub id: String,
    pub tab_id: Option<String>,
    pub saved_rpc_id: Option<String>,
    pub device_id: Option<i64>,
    pub host: Option<String>,
    pub operation: String,
    pub target_datastore: Option<String>,
    pub request_xml: String,
    pub response_xml: Option<String>,
    pub response_truncated: bool,
    pub status: String,
    pub error_message: Option<String>,
    pub duration_ms: Option<i64>,
    pub sent_at: String,
}

const MAX_RESPONSE_SIZE: usize = 1_048_576; // 1MB

/// Record a new history entry.
pub fn insert(
    db: &Connection,
    tab_id: Option<&str>,
    device_id: Option<i64>,
    host: &str,
    operation: &str,
    target_datastore: Option<&str>,
    request_xml: &str,
    response_xml: Option<&str>,
    status: &str,
    error_message: Option<&str>,
    duration_ms: Option<i64>,
) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    let (stored_response, truncated) = match response_xml {
        Some(r) if r.len() > MAX_RESPONSE_SIZE => (Some(&r[..MAX_RESPONSE_SIZE]), true),
        Some(r) => (Some(r), false),
        None => (None, false),
    };

    db.execute(
        "INSERT INTO netconf_history (
            id, tab_id, device_id, host, operation, target_datastore,
            request_xml, response_xml, response_truncated, status,
            error_message, duration_ms, sent_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            id,
            tab_id,
            device_id,
            host,
            operation,
            target_datastore,
            request_xml,
            stored_response,
            if truncated { 1 } else { 0 },
            status,
            error_message,
            duration_ms,
            now,
        ],
    )
    .map_err(|e| NetconfError::Database(e.to_string()))?;

    Ok(id)
}

/// List history for a specific tab, most recent first.
pub fn list_for_tab(
    db: &Connection,
    tab_id: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<HistoryItem>> {
    let mut stmt = db
        .prepare(
            "SELECT id, tab_id, device_id, host, operation, status, duration_ms, sent_at
             FROM netconf_history
             WHERE tab_id = ?1
             ORDER BY sent_at DESC
             LIMIT ?2 OFFSET ?3",
        )
        .map_err(|e| NetconfError::Database(e.to_string()))?;

    let rows = stmt
        .query_map(params![tab_id, limit, offset], |row| {
            Ok(HistoryItem {
                id: row.get(0)?,
                tab_id: row.get(1)?,
                device_id: row.get(2)?,
                host: row.get(3)?,
                operation: row.get(4)?,
                status: row.get(5)?,
                duration_ms: row.get(6)?,
                sent_at: row.get(7)?,
            })
        })
        .map_err(|e| NetconfError::Database(e.to_string()))?;

    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| NetconfError::Database(e.to_string()))
}

/// Get full history detail by ID.
pub fn get_detail(db: &Connection, id: &str) -> Result<HistoryDetail> {
    db.query_row(
        "SELECT id, tab_id, saved_rpc_id, device_id, host, operation, target_datastore,
                request_xml, response_xml, response_truncated, status, error_message,
                duration_ms, sent_at
         FROM netconf_history
         WHERE id = ?1",
        params![id],
        |row| {
            Ok(HistoryDetail {
                id: row.get(0)?,
                tab_id: row.get(1)?,
                saved_rpc_id: row.get(2)?,
                device_id: row.get(3)?,
                host: row.get(4)?,
                operation: row.get(5)?,
                target_datastore: row.get(6)?,
                request_xml: row.get(7)?,
                response_xml: row.get(8)?,
                response_truncated: row.get::<_, i64>(9)? != 0,
                status: row.get(10)?,
                error_message: row.get(11)?,
                duration_ms: row.get(12)?,
                sent_at: row.get(13)?,
            })
        },
    )
    .map_err(|e| NetconfError::Database(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute(
            "CREATE TABLE netconf_history (
                id TEXT PRIMARY KEY,
                tab_id TEXT,
                saved_rpc_id TEXT,
                device_id INTEGER,
                host TEXT,
                operation TEXT NOT NULL,
                target_datastore TEXT,
                request_xml TEXT NOT NULL,
                response_xml TEXT,
                response_truncated INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL,
                error_message TEXT,
                duration_ms INTEGER,
                sent_at TEXT NOT NULL
            )",
            [],
        )
        .unwrap();
        db
    }

    #[test]
    fn test_insert_and_list() {
        let db = setup_db();
        let id = insert(
            &db,
            Some("tab-123"),
            None,
            "device.example.test",
            "get-config",
            Some("running"),
            "<get-config><source><running/></source></get-config>",
            Some("<rpc-reply><data>...</data></rpc-reply>"),
            "success",
            None,
            Some(150),
        )
        .unwrap();

        assert!(!id.is_empty());

        let items = list_for_tab(&db, "tab-123", 10, 0).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].operation, "get-config");
        assert_eq!(items[0].status, "success");
    }

    #[test]
    fn test_get_detail() {
        let db = setup_db();
        let id = insert(
            &db,
            Some("tab-456"),
            Some(1),
            "10.0.0.1",
            "edit-config",
            Some("candidate"),
            "<edit-config>...</edit-config>",
            Some("<rpc-reply><ok/></rpc-reply>"),
            "success",
            None,
            Some(250),
        )
        .unwrap();

        let detail = get_detail(&db, &id).unwrap();
        assert_eq!(detail.operation, "edit-config");
        assert_eq!(detail.target_datastore, Some("candidate".to_string()));
        assert_eq!(detail.request_xml, "<edit-config>...</edit-config>");
        assert_eq!(
            detail.response_xml,
            Some("<rpc-reply><ok/></rpc-reply>".to_string())
        );
        assert!(!detail.response_truncated);
    }

    #[test]
    fn test_response_truncation() {
        let db = setup_db();
        let large_response = "x".repeat(2_000_000); // 2MB
        let id = insert(
            &db,
            Some("tab-789"),
            None,
            "192.168.1.1",
            "get",
            None,
            "<get/>",
            Some(&large_response),
            "success",
            None,
            Some(5000),
        )
        .unwrap();

        let detail = get_detail(&db, &id).unwrap();
        assert!(detail.response_truncated);
        assert_eq!(
            detail.response_xml.as_ref().unwrap().len(),
            MAX_RESPONSE_SIZE
        );
    }
}
