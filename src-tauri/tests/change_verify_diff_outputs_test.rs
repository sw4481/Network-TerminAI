//! Verify the Plan 06-local diff_outputs() helper produces the same result as
//! Plan 05's diff_snapshots() on the same underlying parsed_outputs rows,
//! when those rows are pinned via parsed_snapshots.

use ccie_terminal_lib::change_verify::diff_outputs::diff_outputs;
use ccie_terminal_lib::db;
use ccie_terminal_lib::structured::diff::{diff_snapshots, DiffStatus};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::sync::Arc;
use tempfile::TempDir;

fn open_db() -> (TempDir, Arc<Mutex<Connection>>) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    (dir, Arc::new(Mutex::new(conn)))
}

fn seed_parsed_output(
    conn: &Connection,
    tab_id: &str,
    block_id: &str,
    command: &str,
    data_json: &str,
) -> i64 {
    conn.execute(
        "INSERT INTO tabs(id,title,shell_cmd,cwd) VALUES (?1,'t','sh','/') ON CONFLICT DO NOTHING",
        params![tab_id],
    )
    .unwrap();
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT INTO command_blocks(id,tab_id,cmd,output,started_at,ended_at) VALUES (?1,?2,?3,?4,?5,?5)",
        params![block_id, tab_id, command, b"raw" as &[u8], now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO parsed_outputs(block_id,parser,command,vendor,platform,data_json) VALUES (?1,'genie',?2,'cisco','iosxe',?3)",
        params![block_id, command, data_json],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn pin_snapshot(conn: &Connection, tab_id: &str, parsed_output_id: i64, name: &str) -> i64 {
    conn.execute(
        "INSERT INTO parsed_snapshots(tab_id,name,parsed_output_id) VALUES (?1,?2,?3)",
        params![tab_id, name, parsed_output_id],
    )
    .unwrap();
    conn.last_insert_rowid()
}

#[test]
fn diff_outputs_matches_diff_snapshots_on_list_of_dicts() {
    let (_dir, db) = open_db();
    let conn = db.lock();
    let a_id = seed_parsed_output(
        &conn,
        "tab1",
        "blk-a",
        "show ip bgp summary",
        r#"[{"neighbor":"10.0.0.2","state":"Established"}]"#,
    );
    let b_id = seed_parsed_output(
        &conn,
        "tab1",
        "blk-b",
        "show ip bgp summary",
        r#"[{"neighbor":"10.0.0.2","state":"Active"}]"#,
    );
    let pin_a = pin_snapshot(&conn, "tab1", a_id, "pre");
    let pin_b = pin_snapshot(&conn, "tab1", b_id, "post");
    drop(conn);

    let via_outputs = diff_outputs(a_id, b_id, db.clone()).unwrap();
    let via_snapshots = diff_snapshots(pin_a, pin_b, db.clone()).unwrap();

    assert_eq!(via_outputs.len(), via_snapshots.len());
    let outputs_changed: Vec<_> = via_outputs
        .iter()
        .filter(|d| d.status == DiffStatus::Changed)
        .collect();
    assert_eq!(outputs_changed.len(), 1);
    assert_eq!(outputs_changed[0].column, "state");
}

#[test]
fn diff_outputs_errors_on_missing_id() {
    let (_dir, db) = open_db();
    let err = diff_outputs(9999, 9998, db).unwrap_err();
    assert!(err.to_string().contains("9999") || err.to_string().contains("not found"));
}

#[test]
fn diff_outputs_matches_diff_snapshots_on_nested_dict() {
    let (_dir, db) = open_db();
    let conn = db.lock();
    let a_id = seed_parsed_output(
        &conn, "tab1", "blk-a", "show ip route summary",
        r#"{"total": 1000, "connected": 5}"#,
    );
    let b_id = seed_parsed_output(
        &conn, "tab1", "blk-b", "show ip route summary",
        r#"{"total": 1050, "connected": 5}"#,
    );
    let pin_a = pin_snapshot(&conn, "tab1", a_id, "pre");
    let pin_b = pin_snapshot(&conn, "tab1", b_id, "post");
    drop(conn);

    let via_outputs = diff_outputs(a_id, b_id, db.clone()).unwrap();
    let via_snapshots = diff_snapshots(pin_a, pin_b, db.clone()).unwrap();

    assert_eq!(via_outputs.len(), via_snapshots.len());
    let outputs_changed: Vec<_> = via_outputs
        .iter()
        .filter(|d| d.status == DiffStatus::Changed)
        .collect();
    assert_eq!(outputs_changed.len(), 1);
    assert_eq!(outputs_changed[0].row_key, "total");
}

#[test]
fn diff_outputs_matches_diff_snapshots_with_schema_key() {
    let (_dir, db) = open_db();
    let conn = db.lock();
    // Seed a schema row that pins the alignment key to "intf" — would otherwise
    // be auto-picked as "intf" anyway, but this exercises lookup_schema_key().
    conn.execute(
        "INSERT INTO parse_schemas(parser,command,vendor,platform,schema_json)
         VALUES ('genie','show ip interface brief','cisco','iosxe',?1)",
        params![r#"{"key":"intf"}"#],
    ).unwrap();
    let a_id = seed_parsed_output(
        &conn, "tab1", "blk-a", "show ip interface brief",
        r#"[{"intf":"Gi0/1","status":"up","oper_status":"up"}]"#,
    );
    let b_id = seed_parsed_output(
        &conn, "tab1", "blk-b", "show ip interface brief",
        r#"[{"intf":"Gi0/1","status":"up","oper_status":"down"}]"#,
    );
    let pin_a = pin_snapshot(&conn, "tab1", a_id, "pre");
    let pin_b = pin_snapshot(&conn, "tab1", b_id, "post");
    drop(conn);

    let via_outputs = diff_outputs(a_id, b_id, db.clone()).unwrap();
    let via_snapshots = diff_snapshots(pin_a, pin_b, db.clone()).unwrap();

    assert_eq!(via_outputs.len(), via_snapshots.len());
    let changed: Vec<_> = via_outputs
        .iter()
        .filter(|d| d.status == DiffStatus::Changed)
        .collect();
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].row_key, "Gi0/1");
    assert_eq!(changed[0].column, "oper_status");
}
