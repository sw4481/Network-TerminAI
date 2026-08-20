//! CRUD + state machine for `pcap_captures`.
//!
//! State transitions enforced in `update_status`:
//!   setup → capturing → pulling → ready
//!   any (non-terminal) → failed
//!
//! Terminal states (`ready`, `failed`) cannot be left.

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::types::DeviceKind;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PcapCapture {
    pub id: String,
    pub session_id: Option<String>,
    pub device_ref: String,
    pub device_kind: DeviceKind,
    pub interface: String,
    pub filter: Option<String>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub status: String,
    pub local_path: Option<String>,
    pub packet_count: Option<u32>,
    pub size_bytes: Option<u64>,
    pub error: Option<String>,
    pub created_at: i64,
}

fn row_to_capture(r: &rusqlite::Row) -> rusqlite::Result<PcapCapture> {
    let kind_str: String = r.get(3)?;
    let kind = DeviceKind::from_db_str(&kind_str).unwrap_or(DeviceKind::IosXe);
    Ok(PcapCapture {
        id: r.get(0)?,
        session_id: r.get(1)?,
        device_ref: r.get(2)?,
        device_kind: kind,
        interface: r.get(4)?,
        filter: r.get(5)?,
        started_at: r.get(6)?,
        ended_at: r.get(7)?,
        status: r.get(8)?,
        local_path: r.get(9)?,
        packet_count: r.get::<_, Option<i64>>(10)?.map(|x| x as u32),
        size_bytes: r.get::<_, Option<i64>>(11)?.map(|x| x as u64),
        error: r.get(12)?,
        created_at: r.get(13)?,
    })
}

const SELECT_FIELDS: &str = "id, session_id, device_ref, device_kind, interface, filter, \
     started_at, ended_at, status, local_path, packet_count, size_bytes, error, created_at";

pub fn create(
    conn: &Connection,
    id: &str,
    session_id: Option<&str>,
    device_ref: &str,
    device_kind: DeviceKind,
    interface: &str,
    filter: Option<&str>,
) -> Result<String> {
    if interface.trim().is_empty() {
        return Err(anyhow!("interface is required"));
    }
    conn.execute(
        "INSERT INTO pcap_captures (id, session_id, device_ref, device_kind, interface, filter, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'setup')",
        params![
            id,
            session_id,
            device_ref,
            device_kind.as_db_str(),
            interface,
            filter,
        ],
    )?;
    Ok(id.to_string())
}

fn is_valid_transition(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        ("setup", "capturing")
            | ("capturing", "pulling")
            | ("pulling", "ready")
            | ("setup", "failed")
            | ("capturing", "failed")
            | ("pulling", "failed")
    )
}

pub fn update_status(
    conn: &Connection,
    id: &str,
    new_status: &str,
    error: Option<&str>,
) -> Result<()> {
    let current: String = conn
        .query_row(
            "SELECT status FROM pcap_captures WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| anyhow!("capture {id} not found"))?;
    if !is_valid_transition(&current, new_status) {
        return Err(anyhow!("invalid transition {current} → {new_status}"));
    }
    let started_at_clause = if new_status == "capturing" {
        ", started_at = strftime('%s','now')"
    } else {
        ""
    };
    let ended_at_clause = if new_status == "failed" {
        ", ended_at = strftime('%s','now')"
    } else {
        ""
    };
    let sql = format!(
        "UPDATE pcap_captures SET status = ?2, error = ?3{started_at_clause}{ended_at_clause} WHERE id = ?1"
    );
    conn.execute(&sql, params![id, new_status, error])?;
    Ok(())
}

pub fn finalize(
    conn: &Connection,
    id: &str,
    local_path: &str,
    packet_count: u32,
    size_bytes: u64,
) -> Result<()> {
    let current: String = conn
        .query_row(
            "SELECT status FROM pcap_captures WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| anyhow!("capture {id} not found"))?;
    if !is_valid_transition(&current, "ready") {
        return Err(anyhow!("cannot finalize from status {current}"));
    }
    conn.execute(
        "UPDATE pcap_captures
         SET status = 'ready', local_path = ?2, packet_count = ?3, size_bytes = ?4,
             ended_at = strftime('%s','now')
         WHERE id = ?1",
        params![id, local_path, packet_count as i64, size_bytes as i64],
    )?;
    Ok(())
}

/// Finalize a capture written directly on this computer by dumpcap.
///
/// Remote captures must retain their `capturing -> pulling -> ready` contract,
/// so this is intentionally a separate transition rather than widening
/// `finalize` for every device kind.
pub fn finalize_local(
    conn: &Connection,
    id: &str,
    local_path: &str,
    packet_count: u32,
    size_bytes: u64,
) -> Result<()> {
    let (current, kind): (String, String) = conn
        .query_row(
            "SELECT status, device_kind FROM pcap_captures WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| anyhow!("capture {id} not found"))?;
    if current != "capturing" || kind != "local" {
        return Err(anyhow!(
            "cannot finalize local capture from status {current} and kind {kind}"
        ));
    }
    conn.execute(
        "UPDATE pcap_captures
         SET status = 'ready', local_path = ?2, packet_count = ?3, size_bytes = ?4,
             ended_at = strftime('%s','now')
         WHERE id = ?1",
        params![id, local_path, packet_count as i64, size_bytes as i64],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<PcapCapture>> {
    let sql = format!("SELECT {SELECT_FIELDS} FROM pcap_captures WHERE id = ?1");
    let row = conn
        .query_row(&sql, params![id], row_to_capture)
        .optional()?;
    Ok(row)
}

pub fn list(conn: &Connection, session_id: Option<&str>) -> Result<Vec<PcapCapture>> {
    let (sql, rows) = match session_id {
        Some(sid) => {
            let q = format!(
                "SELECT {SELECT_FIELDS} FROM pcap_captures WHERE session_id = ?1 ORDER BY created_at DESC"
            );
            let mut stmt = conn.prepare(&q)?;
            let rows: Vec<_> = stmt
                .query_map(params![sid], row_to_capture)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            (q, rows)
        }
        None => {
            let q = format!("SELECT {SELECT_FIELDS} FROM pcap_captures ORDER BY created_at DESC");
            let mut stmt = conn.prepare(&q)?;
            let rows: Vec<_> = stmt
                .query_map([], row_to_capture)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            (q, rows)
        }
    };
    let _ = sql;
    Ok(rows)
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    let local_path: Option<String> = conn
        .query_row(
            "SELECT local_path FROM pcap_captures WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    if let Some(path) = local_path {
        if !path.is_empty() {
            // Best-effort: missing file shouldn't block the row delete.
            let _ = std::fs::remove_file(&path);
        }
    }
    conn.execute("DELETE FROM pcap_captures WHERE id = ?1", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_and_migrate;
    use tempfile::TempDir;

    fn fresh() -> (TempDir, Connection) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("t.db");
        let conn = open_and_migrate(&path).unwrap();
        (dir, conn)
    }

    #[test]
    fn create_starts_in_setup() {
        let (_g, conn) = fresh();
        create(
            &conn,
            "c1",
            None,
            "router1",
            DeviceKind::IosXe,
            "Gi0/0",
            None,
        )
        .unwrap();
        let row = get(&conn, "c1").unwrap().unwrap();
        assert_eq!(row.status, "setup");
        assert_eq!(row.device_kind, DeviceKind::IosXe);
    }

    #[test]
    fn happy_path_transitions() {
        let (_g, conn) = fresh();
        create(&conn, "c1", None, "r", DeviceKind::IosXe, "Gi0/0", None).unwrap();
        update_status(&conn, "c1", "capturing", None).unwrap();
        update_status(&conn, "c1", "pulling", None).unwrap();
        finalize(&conn, "c1", "/tmp/x.pcap", 42, 1024).unwrap();
        let row = get(&conn, "c1").unwrap().unwrap();
        assert_eq!(row.status, "ready");
        assert_eq!(row.packet_count, Some(42));
        assert_eq!(row.local_path.as_deref(), Some("/tmp/x.pcap"));
        assert!(row.ended_at.is_some());
    }

    #[test]
    fn failure_from_capturing() {
        let (_g, conn) = fresh();
        create(&conn, "c1", None, "r", DeviceKind::Nxos, "mgmt0", None).unwrap();
        update_status(&conn, "c1", "capturing", None).unwrap();
        update_status(&conn, "c1", "failed", Some("ssh error")).unwrap();
        let row = get(&conn, "c1").unwrap().unwrap();
        assert_eq!(row.status, "failed");
        assert_eq!(row.error.as_deref(), Some("ssh error"));
    }

    #[test]
    fn local_capture_finalizes_without_pulling() {
        let (_g, conn) = fresh();
        create(
            &conn,
            "local-1",
            None,
            "This Computer",
            DeviceKind::Local,
            "1",
            None,
        )
        .unwrap();
        update_status(&conn, "local-1", "capturing", None).unwrap();
        finalize_local(&conn, "local-1", "/tmp/local.pcap", 0, 24).unwrap();
        let row = get(&conn, "local-1").unwrap().unwrap();
        assert_eq!(row.device_kind, DeviceKind::Local);
        assert_eq!(row.status, "ready");
    }

    #[test]
    fn remote_finalize_contract_does_not_accept_local_capturing_state() {
        let (_g, conn) = fresh();
        create(
            &conn,
            "remote-1",
            None,
            "r",
            DeviceKind::IosXe,
            "Gi0/0",
            None,
        )
        .unwrap();
        update_status(&conn, "remote-1", "capturing", None).unwrap();
        assert!(finalize_local(&conn, "remote-1", "/tmp/x.pcap", 0, 24).is_err());
        assert!(finalize(&conn, "remote-1", "/tmp/x.pcap", 0, 24).is_err());
    }

    #[test]
    fn rejects_skip_to_ready() {
        let (_g, conn) = fresh();
        create(&conn, "c1", None, "r", DeviceKind::IosXe, "Gi0/0", None).unwrap();
        // ready isn't reachable via update_status — only finalize lands it.
        let err = update_status(&conn, "c1", "ready", None).unwrap_err();
        assert!(err.to_string().contains("invalid transition"));
    }

    #[test]
    fn rejects_backwards_transition() {
        let (_g, conn) = fresh();
        create(&conn, "c1", None, "r", DeviceKind::IosXe, "Gi0/0", None).unwrap();
        update_status(&conn, "c1", "capturing", None).unwrap();
        let err = update_status(&conn, "c1", "setup", None).unwrap_err();
        assert!(err.to_string().contains("invalid transition"));
    }

    #[test]
    fn cannot_finalize_after_failed() {
        let (_g, conn) = fresh();
        create(&conn, "c1", None, "r", DeviceKind::IosXe, "Gi0/0", None).unwrap();
        update_status(&conn, "c1", "failed", Some("oops")).unwrap();
        assert!(finalize(&conn, "c1", "/tmp/x.pcap", 1, 1).is_err());
    }

    #[test]
    fn list_filters_by_session() {
        let (_g, conn) = fresh();
        create(
            &conn,
            "c1",
            Some("sess-1"),
            "r1",
            DeviceKind::IosXe,
            "Gi0/0",
            None,
        )
        .unwrap();
        create(&conn, "c2", None, "r2", DeviceKind::Eos, "Et1", None).unwrap();
        let s1 = list(&conn, Some("sess-1")).unwrap();
        assert_eq!(s1.len(), 1);
        assert_eq!(s1[0].id, "c1");
        let all = list(&conn, None).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn delete_removes_local_file_best_effort() {
        let (g, conn) = fresh();
        let pcap_path = g.path().join("ghost.pcap");
        std::fs::write(&pcap_path, b"not a real pcap").unwrap();
        create(&conn, "c1", None, "r", DeviceKind::IosXe, "Gi0/0", None).unwrap();
        update_status(&conn, "c1", "capturing", None).unwrap();
        update_status(&conn, "c1", "pulling", None).unwrap();
        finalize(
            &conn,
            "c1",
            pcap_path.to_str().unwrap(),
            1,
            pcap_path.metadata().unwrap().len(),
        )
        .unwrap();
        delete(&conn, "c1").unwrap();
        assert!(get(&conn, "c1").unwrap().is_none());
        assert!(!pcap_path.exists());
    }

    #[test]
    fn delete_when_local_path_missing_still_succeeds() {
        let (_g, conn) = fresh();
        create(&conn, "c1", None, "r", DeviceKind::IosXe, "Gi0/0", None).unwrap();
        delete(&conn, "c1").unwrap();
        assert!(get(&conn, "c1").unwrap().is_none());
    }

    #[test]
    fn create_rejects_empty_interface() {
        let (_g, conn) = fresh();
        assert!(create(&conn, "c1", None, "r", DeviceKind::IosXe, "  ", None).is_err());
    }
}
